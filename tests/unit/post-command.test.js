import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/post-command.js');
const { sanitize } = require('../../src/engine/sanitize');

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-postcmd-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
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
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function ensureSession() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  proxy.insertSession('test-session');
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

function runPostCommand(inputObj) {
  const input = JSON.stringify(inputObj);
  try {
    const stdout = execFileSync('node', [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 20000,
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

function getErrors() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  const errors = proxy.getErrorOutputs();
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return errors;
}

describe('post-command.js', () => {
  it('records error when exitCode != 0 and stderr present', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exitCode: 1, stderr: 'Error: test failed', stdout: '' },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error_string).toBe('Error: test failed');
    const expectedHash = crypto.createHash('md5').update(sanitize('Error: test failed')).digest('hex');
    expect(errors[0].error_hash).toBe(expectedHash);
  });

  it('does not record when exitCode is 0', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { exitCode: 0, stderr: '', stdout: 'hello' },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(0);
  });

  it('does not record when stderr is empty', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { exitCode: 1, stderr: '', stdout: '' },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(0);
  });

  it('truncates stderr to 10KB', () => {
    ensureSession();
    const bigStderr = 'x'.repeat(20000);
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exitCode: 1, stderr: bigStderr, stdout: '' },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error_string.length).toBeLessThanOrEqual(10240);
  });

  it('sanitizes secrets in stderr', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: {
        exitCode: 1,
        stderr: 'Connection failed: redis://user:secret@host:6379',
        stdout: '',
      },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error_string).toContain('[REDACTED_CONN_STRING]');
    expect(errors[0].error_string).not.toContain('secret@host');
  });

  it('produces deterministic MD5 hash for same stderr', () => {
    ensureSession();
    const stderr = 'Error: ECONNREFUSED 127.0.0.1:5432';
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exitCode: 1, stderr, stdout: '' },
    });
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exitCode: 1, stderr, stdout: '' },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(2);
    expect(errors[0].error_hash).toBe(errors[1].error_hash);
  });

  it('exits 0 on invalid input (graceful fail)', () => {
    const result = runPostCommand({});
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when no session exists', () => {
    // No ensureSession() call
    const result = runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'fail' },
      tool_response: { exitCode: 1, stderr: 'error', stdout: '' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('handles exit_code field name variant', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, stderr: 'Error: fail', stdout: '' },
    });
    const errors = getErrors();
    expect(errors).toHaveLength(1);
  });
});

describe('post-command.js — extractCommitHash', () => {
  function loadPostCommand() {
    delete require.cache[require.resolve('../../src/hooks/post-command')];
    delete require.cache[require.resolve('../../src/engine/protection')];
    delete require.cache[require.resolve('../../src/engine/blame-cache')];
    delete require.cache[require.resolve('../../src/engine/debug-log')];
    return require('../../src/hooks/post-command');
  }

  it('extracts short hash from git commit output', () => {
    const { extractCommitHash } = loadPostCommand();
    expect(extractCommitHash('[main abc1234] Fix OAuth token handling')).toBe('abc1234');
  });

  it('extracts long hash from git commit output', () => {
    const { extractCommitHash } = loadPostCommand();
    const longHash = 'a'.repeat(40);
    expect(extractCommitHash(`[main ${longHash}] Fix`)).toBe(longHash);
  });

  it('extracts hash from feature branch', () => {
    const { extractCommitHash } = loadPostCommand();
    expect(extractCommitHash('[feature/auth 1234567] Add login')).toBe('1234567');
  });

  it('returns null for non-commit output', () => {
    const { extractCommitHash } = loadPostCommand();
    expect(extractCommitHash('npm test passed')).toBeNull();
    expect(extractCommitHash('')).toBeNull();
    expect(extractCommitHash(null)).toBeNull();
  });

  it('extracts hash from merge commit output', () => {
    const { extractCommitHash } = loadPostCommand();
    expect(extractCommitHash('[main abcdef1] Merge branch feature/auth')).toBe('abcdef1');
  });
});

describe('post-command.js — live payload shapes', () => {
  // Live Claude Code sends Bash FAILURES as a plain string ("Error: Exit code 1\n…"),
  // and success objects carry NO exitCode field. Fixtures with an invented
  // { exitCode: 1 } kept the suite green while the error arm was dead in production.
  it('captures a live-shape string failure response', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'Error: Exit code 1\nFAIL tests/foo.test.js\nAssertionError: expected 1 to be 2',
    });
    const errors = getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error_string).toContain('AssertionError');
  });

  it('does not record an error for a live-shape success object (no exitCode field)', () => {
    ensureSession();
    runPostCommand({
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' },
      tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false },
    });
    expect(getErrors()).toHaveLength(0);
  });

  it('attributes the error to the payload session_id, not the newest session', () => {
    ensureSession(); // 'test-session'
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = loadDb();
    db.getDb(projectDir).insertSession('newer-concurrent-session');
    db.closeDb();
    delete require.cache[require.resolve('../../src/engine/db')];
    delete process.env.CLAUDE_PLUGIN_DATA;

    runPostCommand({
      cwd: projectDir,
      session_id: 'test-session',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'Error: Exit code 1\nsomething broke',
    });
    const errors = getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].session_id).toBe('test-session');
  });
});
