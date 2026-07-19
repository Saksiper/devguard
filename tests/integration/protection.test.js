import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PRE_EDIT_HOOK = path.resolve(__dirname, '../../src/hooks/pre-edit.js');
const { normalizePath } = require('../../src/engine/normalize-path');

let tmpDir;
let repoDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function clearModules() {
  const modules = [
    '../../src/engine/db', '../../src/engine/sanitize', '../../src/engine/debug-log',
    '../../src/engine/config', '../../src/engine/cycle-detector',
    '../../src/engine/line-resolver', '../../src/engine/protection',
    '../../src/engine/blame-cache', '../../src/hooks/pre-edit',
    '../../src/hooks/post-compact',
  ];
  for (const m of modules) {
    try { delete require.cache[require.resolve(m)]; } catch { /* ok */ }
  }
}

function createGitRepo() {
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
  return repoDir;
}

function commitFile(name, content, msg) {
  fs.writeFileSync(path.join(repoDir, name), content, 'utf-8');
  execSync(`git add "${name}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoDir, stdio: 'pipe' });
  return execSync('git log -1 --format=%H', { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function freshDb() {
  const db = loadDb();
  const proxy = db.getDb(repoDir);
  proxy.insertSession('test-session');
  return { db, proxy };
}

function runPreEdit(inputObj) {
  const input = JSON.stringify(inputObj);
  try {
    const stdout = execFileSync('node', [PRE_EDIT_HOOK], {
      input,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tmpDir,
        DEVGUARD_DEBUG: '0',
      },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-integ-prot-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  createGitRepo();
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  clearModules();
  delete process.env.CLAUDE_PLUGIN_DATA;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

describe('Integration: Protection Scenarios', () => {
  it('Scenario 1: OAuth fix commit → protection record → different issue edit → warning', () => {
    // 1. Create file with OAuth fix
    const content = 'function auth() {\n  const token = getToken();\n  return validate(token);\n}\n';
    const commitHash = commitFile('auth.js', content, 'Fix OAuth token handling');

    // 2. Create protection record in DB (use absolute path like Claude Code does)
    const absFile = normalizePath(path.join(repoDir, 'auth.js'));
    const { db, proxy } = freshDb();
    const issueId = proxy.insertIssue({ title: 'OAuth token expired', status: 'fixed' });
    const changeId = proxy.insertChange({ file: absFile, session_id: 'test-session' });
    proxy.insertProtectedZone({
      issue_id: issueId,
      change_id: changeId,
      file: absFile,
      protected_commit: commitHash,
      temp_protection: 0,
      reason: 'Token validation fix',
    });
    db.closeDb();
    clearModules();

    // 3. Try to edit the protected file
    const result = runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: '  const token = getToken();',
        new_string: '  const token = getCachedToken();',
      },
    });

    // 4. Expect warning (not block — protection uses 'warn')
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('WARNING');
    expect(output.hookSpecificOutput.additionalContext).toContain('Token validation fix');
  });

  it('Scenario 2: Unprotected file edit → no warning', () => {
    commitFile('utils.js', 'function add(a, b) { return a + b; }\n', 'Add utils');
    const { db } = freshDb();
    db.closeDb();
    clearModules();

    const absFile = normalizePath(path.join(repoDir, 'utils.js'));
    const result = runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'function add(a, b) { return a + b; }',
        new_string: 'function add(a, b) { return a + b + 0; }',
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('Scenario 3: Temp protection (issue A) → different issue (B) edit → warning', () => {
    commitFile('pipeline.ts', 'line1\nline2\nline3\nline4\nline5\n', 'Init pipeline');

    const absFile = normalizePath(path.join(repoDir, 'pipeline.ts'));
    const { db, proxy } = freshDb();
    const issueA = proxy.insertIssue({ title: 'MCP timeout fix', status: 'fixed' });
    proxy.insertIssue({ title: 'Memory leak', status: 'open' });
    const changeId = proxy.insertChange({ file: absFile, session_id: 'test-session' });
    proxy.insertProtectedZone({
      issue_id: issueA,
      change_id: changeId,
      file: absFile,
      temp_lines_start: 2,
      temp_lines_end: 4,
      temp_protection: 1,
      reason: 'cleanSpawnEnv added',
    });
    db.closeDb();
    clearModules();

    const result = runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'line3',
        new_string: 'modified_line3',
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('WARNING');
    expect(output.hookSpecificOutput.additionalContext).toContain('cleanSpawnEnv added');
  });

  it('Scenario 3b: Same-issue exemption — editing own fix skips warning', () => {
    commitFile('pipeline.ts', 'line1\nline2\nline3\nline4\nline5\n', 'Init pipeline');

    const absFile = normalizePath(path.join(repoDir, 'pipeline.ts'));
    const { db, proxy } = freshDb();
    const issueId = proxy.insertIssue({ title: 'MCP timeout fix', status: 'open' });
    const changeId = proxy.insertChange({ file: absFile, session_id: 'test-session' });
    proxy.insertProtectedZone({
      issue_id: issueId,
      change_id: changeId,
      file: absFile,
      temp_lines_start: 2,
      temp_lines_end: 4,
      temp_protection: 1,
      reason: 'cleanSpawnEnv added',
    });
    db.closeDb();
    clearModules();

    const result = runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'line3',
        new_string: 'modified_line3',
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('Scenario 4: PostCompact → pending injection → next edit injects summary', () => {
    commitFile('app.js', 'const x = 1;\n', 'Init');
    const absFile = normalizePath(path.join(repoDir, 'app.js'));

    const { db, proxy } = freshDb();
    proxy.insertIssue({ title: 'Active bug', status: 'open' });
    proxy.setPendingSummary('test-session', 'DevGuard Session Summary:\n- Active issues: Active bug');
    db.closeDb();
    clearModules();

    const result = runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard Session Summary');
    expect(output.hookSpecificOutput.additionalContext).toContain('Active bug');
  });

  it('Scenario 5: Pending summary consumed after first injection', () => {
    commitFile('app.js', 'const x = 1;\n', 'Init');
    const absFile = normalizePath(path.join(repoDir, 'app.js'));

    const { db, proxy } = freshDb();
    proxy.setPendingSummary('test-session', 'DevGuard Session Summary:\n- Test summary');
    db.closeDb();
    clearModules();

    // First edit: should inject
    runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: { file_path: absFile, old_string: 'const x = 1;', new_string: 'const x = 2;' },
    });

    // Second edit: should NOT inject (consumed)
    fs.writeFileSync(absFile, 'const x = 2;\n');

    const result = runPreEdit({
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: { file_path: absFile, old_string: 'const x = 2;', new_string: 'const x = 3;' },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });
});
