import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOKS_DIR = path.resolve(__dirname, '../../src/hooks');

let tmpDir, repoDir;

function hookPath(name) {
  return path.join(HOOKS_DIR, `${name}.js`);
}

function runHook(name, input, envOverrides = {}) {
  try {
    const stdout = execFileSync('node', [hookPath(name)], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0', DEVGUARD_MODEL_DIR: path.join(tmpDir, 'no-model'), DEVGUARD_OFFLINE: '1', ...envOverrides },
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ok */ }
    return { stdout, exitCode: 0, parsed };
  } catch (err) {
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch { /* ok */ }
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status, parsed };
  }
}

function createGitRepo() {
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
}

function commitFile(name, content, msg) {
  fs.writeFileSync(path.join(repoDir, name), content, 'utf-8');
  execSync(`git add "${name}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoDir, stdio: 'pipe' });
  return execSync('git log -1 --format=%H', { cwd: repoDir, encoding: 'utf-8' }).trim();
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

function loadDb() {
  clearModules();
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-e2e-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  createGitRepo();
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  clearModules();
  delete process.env.CLAUDE_PLUGIN_DATA;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

describe('E2E: Scenario 1 — Cycle detection via real hook subprocess', () => {
  it('session-start + 3x post-edit same file + errors → pre-edit warns', () => {
    // Step 1: Start session via hook
    const sessionResult = runHook('session-start', { cwd: repoDir });
    expect(sessionResult.exitCode).toBe(0);

    // Step 2: 3 rounds of post-edit same file + error via post-command
    for (let i = 0; i < 3; i++) {
      const postEditResult = runHook('post-edit', {
        cwd: repoDir,
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(repoDir, 'app.js').replace(/\\/g, '/'),
          old_string: 'old',
          new_string: `new_${i}`,
        },
      });
      expect(postEditResult.exitCode).toBe(0);

      // Same error each time → error hash cycle
      const postCmdResult = runHook('post-command', {
        cwd: repoDir,
        tool_input: { command: 'npm test' },
        tool_response: { exitCode: 1, stderr: 'Error: same error always', stdout: '' },
      });
      expect(postCmdResult.exitCode).toBe(0);
    }

    // Step 3: pre-edit on same file → should detect cycle (warn or block)
    const preEditResult = runHook('pre-edit', {
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'app.js').replace(/\\/g, '/'),
        old_string: 'old',
        new_string: 'new2',
      },
    });

    // Cycle detected: either block (exit 2) or warn (exit 0 with additionalContext)
    if (preEditResult.exitCode === 2) {
      // Blocked: cycle message in stderr
      expect(preEditResult.stderr).toBeTruthy();
      expect(preEditResult.stderr).toMatch(/edited|occurred|similar|DevGuard/);
    } else {
      // Warned: additionalContext set
      expect(preEditResult.exitCode).toBe(0);
      expect(preEditResult.parsed).toBeTruthy();
      const ctx = preEditResult.parsed?.hookSpecificOutput?.additionalContext;
      expect(ctx).toBeDefined();
      expect(ctx).toMatch(/DevGuard|edited|occurred|similar/);
    }
  });
});

describe('E2E: Scenario 2 — Protection warning via DB seed + pre-edit subprocess', () => {
  it('temp protection zone → pre-edit warns when editing protected lines', () => {
    // Create file in repo
    commitFile('auth.js', 'line1\nline2\nline3\nline4\nline5\n', 'Init auth.js');
    const absFile = path.join(repoDir, 'auth.js').replace(/\\/g, '/');

    // Seed DB: session + issue + change + protected zone (temp)
    const db = loadDb();
    const proxy = db.getDb(repoDir);
    proxy.insertSession('test-prot-session');
    const issueId = proxy.insertIssue({ title: 'Auth token expiry fix', status: 'fixed' });
    const changeId = proxy.insertChange({ file: absFile, session_id: 'test-prot-session' });
    proxy.insertProtectedZone({
      issue_id: issueId,
      change_id: changeId,
      file: absFile,
      temp_lines_start: 2,
      temp_lines_end: 4,
      temp_protection: 1,
      reason: 'Token validation added',
    });
    db.closeDb();
    clearModules();

    // Run pre-edit targeting protected lines
    const result = runHook('pre-edit', {
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'line3',
        new_string: 'line3_modified',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeTruthy();
    const ctx = result.parsed?.hookSpecificOutput?.additionalContext;
    expect(ctx).toBeDefined();
    expect(ctx).toContain('WARNING');
    expect(ctx).toContain('Token validation added');
  });
});

describe('E2E: Scenario 3 — Session handoff (PostCompact → pre-edit injection)', () => {
  it('post-compact saves pending summary → pre-edit injects it', () => {
    // Create a session
    commitFile('app.js', 'const x = 1;\n', 'Init');
    const absFile = path.join(repoDir, 'app.js').replace(/\\/g, '/');

    // Seed DB with session + enough data for buildSummary to produce content
    const db = loadDb();
    const proxy = db.getDb(repoDir);
    proxy.insertSession('compact-session');
    proxy.insertIssue({ title: 'Memory leak in auth', status: 'open' });
    db.closeDb();
    clearModules();

    // Run post-compact to build and save summary
    const compactResult = runHook('post-compact', { cwd: repoDir });
    expect(compactResult.exitCode).toBe(0);

    // Run pre-edit — should inject the pending summary
    const preEditResult = runHook('pre-edit', {
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    });

    expect(preEditResult.exitCode).toBe(0);
    expect(preEditResult.parsed).toBeTruthy();
    const ctx = preEditResult.parsed?.hookSpecificOutput?.additionalContext;
    expect(ctx).toBeDefined();
    expect(ctx).toContain('DevGuard Session Summary');
    expect(ctx).toContain('Memory leak in auth');
  });
});

describe('E2E: Scenario 4 — Graceful fail chain (non-existent data dir)', () => {
  it('all hooks exit 0 when CLAUDE_PLUGIN_DATA is non-existent path', () => {
    const badDir = path.join(os.tmpdir(), `devguard-nonexistent-${Date.now()}`);
    const hookNames = ['session-start', 'post-edit', 'post-command', 'post-compact', 'pre-edit', 'user-prompt-submit'];

    for (const name of hookNames) {
      const result = runHook(name, { cwd: repoDir, tool_input: {}, tool_response: {} }, {
        CLAUDE_PLUGIN_DATA: badDir,
      });
      expect(result.exitCode).toBe(0);
    }
  });
});

describe('E2E: Scenario 5 — Periodic injection after 20 edits', () => {
  it('20 changes in DB + open issue → pre-edit injects periodic summary', () => {
    commitFile('app.js', 'const x = 1;\n', 'Init');
    const absFile = path.join(repoDir, 'app.js').replace(/\\/g, '/');

    // Seed: session with last_injection_change_id = 0, 20 changes spread across
    // different files (so cycle-detector does not trigger), open issue
    const db = loadDb();
    const proxy = db.getDb(repoDir);
    proxy.insertSession('periodic-session');
    proxy.insertIssue({ title: 'Performance regression', status: 'open' });

    // 20 changes, each in a different file → no single file exceeds block_threshold
    for (let i = 0; i < 20; i++) {
      proxy.insertChange({
        session_id: 'periodic-session',
        file: `${repoDir}/module-${i}.js`.replace(/\\/g, '/'),
        action: 'Edit',
        diff_text: `unique_old_content_${i}_xyz`,
        description: `unique_new_content_${i}_abc`,
      });
    }
    db.closeDb();
    clearModules();

    // pre-edit on absFile (which has 0 prior changes) with unique content
    // → no cycle, no pending summary → triggers periodic injection
    const result = runHook('pre-edit', {
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: absFile,
        old_string: 'completely_unique_never_seen_before_content_xyz123',
        new_string: 'something_new',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeTruthy();
    const ctx = result.parsed?.hookSpecificOutput?.additionalContext;
    expect(ctx).toBeDefined();
    expect(ctx).toContain('DevGuard Session Summary');
    expect(ctx).toContain('Performance regression');
  });
});
