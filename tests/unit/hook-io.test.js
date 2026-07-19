import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_IO_PATH = path.resolve(__dirname, '../../src/engine/hook-io.js');

function runHookScript(scriptContent, stdinData = '') {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `hook-io-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  const fullScript = `const hookIO = require(${JSON.stringify(HOOK_IO_PATH)});\n${scriptContent}`;

  fs.writeFileSync(tmpFile, fullScript, 'utf-8');
  try {
    const result = execFileSync('node', [tmpFile], {
      input: stdinData,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* cleanup best-effort */ }
  }
}

describe('hook-io', () => {
  describe('readInput()', () => {
    it('parses valid JSON from stdin', () => {
      const input = JSON.stringify({ tool_name: 'Edit', file_path: '/test.js' });
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        input,
      );
      const result = JSON.parse(stdout);
      expect(result).toEqual({ tool_name: 'Edit', file_path: '/test.js' });
    });

    it('returns empty object for empty stdin', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('returns empty object for invalid JSON', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '{broken json!!!',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('handles unicode content', () => {
      const input = JSON.stringify({ message: 'Türkçe karakter: şçğüöı' });
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        input,
      );
      const result = JSON.parse(stdout);
      expect(result.message).toBe('Türkçe karakter: şçğüöı');
    });

    it('returns empty object for whitespace-only stdin', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '   \n  \t  \r\n  ',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('handles JSON with CRLF line endings', () => {
      const input = '{"key": "value"}\r\n';
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        input,
      );
      expect(JSON.parse(stdout)).toEqual({ key: 'value' });
    });

    it('handles large JSON input', () => {
      const largeObj = { data: 'x'.repeat(100000) };
      const input = JSON.stringify(largeObj);
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify({ len: data.data.length }));',
        input,
      );
      expect(JSON.parse(stdout).len).toBe(100000);
    });

    it('returns empty object for non-object JSON (string)', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '"just a string"',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('returns empty object for non-object JSON (number)', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '42',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('returns empty object for non-object JSON (array)', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '[1, 2, 3]',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('returns empty object for JSON null', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        'null',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('does not pollute Object.prototype via __proto__', () => {
      const { stdout } = runHookScript(
        `const data = hookIO.readInput();
         const polluted = ({}).polluted;
         process.stdout.write(JSON.stringify({ hasProp: data.hasOwnProperty("__proto__"), polluted }));`,
        '{"__proto__": {"polluted": true}}',
      );
      const result = JSON.parse(stdout);
      expect(result.polluted).toBeUndefined();
    });

    it('returns empty object for concatenated JSON', () => {
      const { stdout } = runHookScript(
        'const data = hookIO.readInput(); process.stdout.write(JSON.stringify(data));',
        '{"a":1}\n{"b":2}',
      );
      expect(JSON.parse(stdout)).toEqual({});
    });
  });

  describe('respond()', () => {
    it('writes JSON to stdout and exits with code 0', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.respond({ result: "ok" });',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ result: 'ok' });
    });

    it('handles empty object response', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.respond({});',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('handles nested object response', () => {
      const { stdout } = runHookScript(
        'hookIO.respond({ hookSpecificOutput: { permissionDecision: "allow" } });',
      );
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('falls back to empty JSON on circular reference', () => {
      const { stdout, exitCode } = runHookScript(
        'const obj = {}; obj.self = obj; hookIO.respond(obj);',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('falls back to empty JSON for undefined argument', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.respond(undefined);',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('falls back to empty JSON for null argument', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.respond(null);',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('falls back to empty JSON for array argument', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.respond([1, 2, 3]);',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});
    });

    it('falls back to empty JSON for string argument', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.respond("not an object");',
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});
    });
  });

  describe('context()', () => {
    it('wraps additionalContext in hookSpecificOutput and exits 0', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.context("DevGuard: 3 cycle detected in auth.js");',
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.additionalContext).toBe(
        'DevGuard: 3 cycle detected in auth.js',
      );
    });

    it('handles multiline context', () => {
      const { stdout } = runHookScript(
        'hookIO.context("Line 1\\nLine 2\\nLine 3");',
      );
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.additionalContext).toBe('Line 1\nLine 2\nLine 3');
    });

    it('handles empty context', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.context("");',
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.additionalContext).toBe('');
    });

    it('includes hookEventName when passed (required by Claude Code)', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.context("cycle warn", "PreToolUse");',
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(result.hookSpecificOutput.additionalContext).toBe('cycle warn');
    });

    it('omits hookEventName when not passed (backward compat)', () => {
      const { stdout } = runHookScript('hookIO.context("ctx");');
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).not.toHaveProperty('hookEventName');
    });
  });

  describe('context() — edge cases', () => {
    it('handles null context gracefully', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.context(null);',
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.additionalContext).toBeNull();
    });

    it('handles undefined context gracefully', () => {
      const { exitCode } = runHookScript(
        'hookIO.context(undefined);',
      );
      expect(exitCode).toBe(0);
    });
  });

  describe('allow()', () => {
    it('responds with permissionDecision allow and exits 0', () => {
      const { stdout, exitCode } = runHookScript(
        'hookIO.allow();',
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    });
  });

  describe('export contract', () => {
    it('exports exactly 4 functions', () => {
      const { stdout } = runHookScript(
        `const keys = Object.keys(hookIO);
         const types = keys.map(k => typeof hookIO[k]);
         process.stdout.write(JSON.stringify({ keys, types }));`,
      );
      const result = JSON.parse(stdout);
      expect(result.keys).toEqual(['readInput', 'respond', 'context', 'allow']);
      expect(result.types).toEqual(['function', 'function', 'function', 'function']);
    });
  });
});
