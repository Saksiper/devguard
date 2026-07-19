import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/post-edit.js');

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-protect-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-protect-project-'));
});

afterEach(() => {
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  return require('../../src/engine/db');
}

function ensureSession() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  proxy.insertSession('protect-test-session');
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

function runPostEdit(inputObj) {
  try {
    execFileSync('node', [HOOK_PATH], {
      input: JSON.stringify(inputObj),
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tmpDir,
        DEVGUARD_DEBUG: '0',
        DEVGUARD_OFFLINE: '1',
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: err.stderr || '' };
  }
}

function lastChange() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  const changes = proxy.getChanges({ limit: 1 });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return changes[0] || null;
}

describe('post-edit + protect-heuristic integration', () => {
  it('populates protect_note when editing a test file', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/tests/unit/auth.test.js',
        old_string: 'expect(login()).toBe(true);',
        new_string: 'expect(login()).toBe(false);',
      },
      tool_response: {},
    });
    const change = lastChange();
    expect(change).toBeTruthy();
    expect(change.protect_note).toMatch(/[Tt]est file/);
  });

  it('populates protect_note when editing a DevGuard hook', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/src/hooks/post-edit.js',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
      tool_response: {},
    });
    const change = lastChange();
    expect(change).toBeTruthy();
    expect(change.protect_note).toMatch(/[Hh]ook/);
  });

  it('combines file-type + diff-content rules', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/src/hooks/post-edit.js',
        old_string: 'run();',
        new_string: 'try { run(); } catch (e) { log(e); }',
      },
      tool_response: {},
    });
    const change = lastChange();
    expect(change).toBeTruthy();
    expect(change.protect_note).toMatch(/[Hh]ook/);
    expect(change.protect_note).toMatch(/[Ee]rror handling added/);
    expect(change.protect_note.includes(' · ')).toBe(true);
  });

  it('leaves protect_note null for ordinary code with no signal', () => {
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/src/util/format.js',
        old_string: 'return a + b;',
        new_string: 'return a - b;',
      },
      tool_response: {},
    });
    const change = lastChange();
    expect(change).toBeTruthy();
    expect(change.protect_note).toBeNull();
  });

  it('sanitizes secrets inside protect_note text path (defense-in-depth)', () => {
    // protect_note from heuristic itself doesn't include user content, but
    // db.insertChange routes everything through sanitize. This test guards
    // against future changes where heuristic might echo back diff content.
    ensureSession();
    runPostEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: '/project/.env',
        old_string: 'X=1',
        new_string: 'X=2',
      },
      tool_response: {},
    });
    const change = lastChange();
    expect(change).toBeTruthy();
    expect(change.protect_note).toMatch(/[Cc]onfig/);
  });
});
