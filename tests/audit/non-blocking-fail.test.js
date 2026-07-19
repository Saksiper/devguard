import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOOKS = [
  { name: 'pre-edit', path: path.resolve(__dirname, '../../src/hooks/pre-edit.js') },
  { name: 'post-edit', path: path.resolve(__dirname, '../../src/hooks/post-edit.js') },
  { name: 'post-command', path: path.resolve(__dirname, '../../src/hooks/post-command.js') },
  { name: 'post-compact', path: path.resolve(__dirname, '../../src/hooks/post-compact.js') },
  { name: 'session-start', path: path.resolve(__dirname, '../../src/hooks/session-start.js') },
  { name: 'user-prompt-submit', path: path.resolve(__dirname, '../../src/hooks/user-prompt-submit.js') },
  { name: 'stop', path: path.resolve(__dirname, '../../src/hooks/stop.js') },
  { name: 'session-end', path: path.resolve(__dirname, '../../src/hooks/session-end.js') },
];

/**
 * Run a hook as a subprocess. Returns { stdout, stderr, exitCode }.
 * Never throws — all subprocess errors are captured.
 */
function runHook(hookPath, stdinData, envOverrides = {}) {
  try {
    const stdout = execFileSync('node', [hookPath], {
      input: stdinData,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVGUARD_DEBUG: '0',
        ...envOverrides,
      },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-nbf-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

describe('Non-blocking fail audit — CLAUDE_PLUGIN_DATA undefined', () => {
  for (const hook of HOOKS) {
    it(`${hook.name} exits 0 when CLAUDE_PLUGIN_DATA is completely absent`, () => {
      const env = { ...process.env };
      delete env.CLAUDE_PLUGIN_DATA;
      // Also remove any DEVGUARD_DEBUG noise
      env.DEVGUARD_DEBUG = '0';

      let exitCode = 0;
      try {
        execFileSync('node', [hook.path], {
          input: JSON.stringify({ cwd: tmpDir }),
          encoding: 'utf-8',
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } catch (err) {
        exitCode = err.status ?? 1;
      }

      expect(exitCode).toBe(0);
    });
  }
});

describe('Non-blocking fail audit', () => {
  for (const hook of HOOKS) {
    describe(hook.name, () => {
      it('exits 0 with DB unavailable', () => {
        // Create a FILE at tmpDir/notadir so that mkdirSync(notadir/subdir) fails
        // because notadir is a file, not a directory.
        const blockingFile = path.join(tmpDir, 'notadir');
        fs.writeFileSync(blockingFile, 'x');
        const result = runHook(
          hook.path,
          JSON.stringify({ cwd: tmpDir }),
          { CLAUDE_PLUGIN_DATA: path.join(tmpDir, 'notadir', 'subdir') }
        );
        expect(result.exitCode).toBe(0);
      });

      it('exits 0 with corrupt JSON input', () => {
        const result = runHook(
          hook.path,
          '{{{invalid json!!!',
          { CLAUDE_PLUGIN_DATA: tmpDir }
        );
        expect(result.exitCode).toBe(0);
      });

      it('exits 0 with empty stdin', () => {
        const result = runHook(
          hook.path,
          '',
          { CLAUDE_PLUGIN_DATA: tmpDir }
        );
        expect(result.exitCode).toBe(0);
      });

      it('exits 0 with missing required fields', () => {
        const result = runHook(
          hook.path,
          JSON.stringify({}),
          { CLAUDE_PLUGIN_DATA: tmpDir }
        );
        expect(result.exitCode).toBe(0);
      });

      it('exits 0 with invalid field types', () => {
        const result = runHook(
          hook.path,
          JSON.stringify({ cwd: 123, tool_input: 'not-an-object', tool_response: null }),
          { CLAUDE_PLUGIN_DATA: tmpDir }
        );
        expect(result.exitCode).toBe(0);
      });
    });
  }
});
