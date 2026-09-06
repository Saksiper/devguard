import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  extractErrorEssence,
  parseDbTs,
  isErrorFresh,
  ERROR_MAX_AGE_MINUTES,
  MAX_ESSENCE_LEN,
} = require('../../src/engine/error-digest');

describe('extractErrorEssence', () => {
  it('returns null for empty input', () => {
    expect(extractErrorEssence('')).toBeNull();
    expect(extractErrorEssence(null)).toBeNull();
    expect(extractErrorEssence(undefined)).toBeNull();
  });

  it('returns null when no error signature is present', () => {
    // Real row (id=52): a failed command whose whole output was a stdout banner.
    expect(extractErrorEssence('--- MEMORY.md ---')).toBeNull();
    expect(extractErrorEssence('EMPTY ok\nbytes 17428\nall good')).toBeNull();
  });

  it('picks the error line even when stdout noise comes first', () => {
    // Real row (id=45): tool banner first, real cause last. The old
    // substring(0,100) preview showed only the banner.
    const raw = [
      '9.7.1 dist/index.umd.cjs ./dist/index.mjs {".":{"import":{"types":"./dist/index.d.ts"}}}',
      'file:///C:/tmp/probe/xl.mjs:20',
      '    const x = undefined.slice(0);',
      'TypeError: Cannot read properties of undefined (reading \'slice\')',
      '    at file:///C:/tmp/probe/xl.mjs:20:18',
      '',
      'Node.js v24.12.0',
    ].join('\n');
    expect(extractErrorEssence(raw)).toBe(
      "TypeError: Cannot read properties of undefined (reading 'slice')"
    );
  });

  it('scans from the end so the LAST error line wins', () => {
    const raw = [
      'Error: first failure that was retried and recovered',
      'retrying...',
      'SyntaxError: Invalid or unexpected token',
      '',
      'Node.js v24.12.0',
    ].join('\n');
    expect(extractErrorEssence(raw)).toBe('SyntaxError: Invalid or unexpected token');
  });

  it('recognizes a plain Error: line', () => {
    // Real row (id=47).
    const raw = '--- hucre tipleri ---\nB2 t=s len=4\nError: Text length must not exceed 32767 characters\n    at foo';
    expect(extractErrorEssence(raw)).toBe('Error: Text length must not exceed 32767 characters');
  });

  it('recognizes node error codes', () => {
    expect(extractErrorEssence("stuff\n  code: 'ENOENT',\n  syscall: 'open'")).toContain('ENOENT');
    expect(extractErrorEssence("out\n  code: 'ERR_MODULE_NOT_FOUND',")).toContain('ERR_MODULE_NOT_FOUND');
    expect(extractErrorEssence('noise\nError [MODULE_NOT_FOUND]: Cannot find module')).toContain('MODULE_NOT_FOUND');
  });

  it('prefers the explanatory sentence over the code dump below it', () => {
    // Real row (id=51): a node crash prints BOTH. Plain bottom-up scanning returns
    // "code: 'ERR_MODULE_NOT_FOUND'," which names the failure without saying what failed.
    const raw = [
      'node:internal/modules/run_main:107',
      '    triggerUncaughtException(',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\tmp\\aiSegment.js' imported from C:\\tmp\\x.mjs",
      '    at packageResolve (node:internal/modules/esm/resolve:274:9)',
      "  code: 'ERR_MODULE_NOT_FOUND',",
      '}',
      '',
      'Node.js v24.12.0',
    ].join('\n');
    expect(extractErrorEssence(raw)).toBe(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\tmp\\aiSegment.js' imported from C:\\tmp\\x.mjs"
    );
  });

  it('caps a very long failure line', () => {
    const raw = 'Error: ' + 'x'.repeat(500);
    expect(extractErrorEssence(raw).length).toBe(MAX_ESSENCE_LEN);
  });

  it('recognizes python failures', () => {
    const raw = [
      'starting job',
      'Traceback (most recent call last):',
      '  File "<string>", line 3, in <module>',
      "FileNotFoundError: [Errno 2] No such file or directory: 'dump.jsonl'",
    ].join('\n');
    expect(extractErrorEssence(raw)).toBe(
      "FileNotFoundError: [Errno 2] No such file or directory: 'dump.jsonl'"
    );
  });

  it('recognizes shell and git failures', () => {
    expect(extractErrorEssence('bash: frobnicate: command not found')).toContain('command not found');
    expect(extractErrorEssence('on branch x\nfatal: not a git repository')).toContain('fatal:');
  });

  it('recognizes prefix-less failures printed as a bare sentence', () => {
    // Tools like curl/psql print no Error: prefix at all.
    expect(extractErrorEssence('Connection refused')).toBe('Connection refused');
    expect(extractErrorEssence('cp: /etc/shadow: Permission denied')).toContain('Permission denied');
  });

  it('handles CRLF and trims the returned line', () => {
    const raw = 'noise\r\n   TypeError: boom   \r\n\r\nNode.js v24.12.0\r\n';
    expect(extractErrorEssence(raw)).toBe('TypeError: boom');
  });

  it('does not return the bare Node version footer', () => {
    expect(extractErrorEssence('some output\n\nNode.js v24.12.0')).toBeNull();
  });
});

describe('parseDbTs', () => {
  it('parses a sqlite CURRENT_TIMESTAMP string as UTC', () => {
    expect(parseDbTs('2026-09-03 08:35:05')).toBe(Date.UTC(2026, 8, 3, 8, 35, 5));
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseDbTs(null)).toBeNull();
    expect(parseDbTs('')).toBeNull();
    expect(parseDbTs('not a date')).toBeNull();
  });
});

describe('isErrorFresh', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);

  it('accepts an error from a few minutes ago', () => {
    expect(isErrorFresh('2026-09-06 11:50:00', now)).toBe(true);
  });

  it('rejects the measured KOAV case: a 3-day-old error', () => {
    expect(isErrorFresh('2026-09-03 08:35:05', now)).toBe(false);
  });

  it('rejects an error just past the age limit', () => {
    const justOver = now - (ERROR_MAX_AGE_MINUTES + 1) * 60000;
    const ts = new Date(justOver).toISOString().replace('T', ' ').slice(0, 19);
    expect(isErrorFresh(ts, now)).toBe(false);
  });

  it('fails open on an unreadable timestamp', () => {
    // Same rule as the existing issue-age filter: unknown timestamps stay.
    expect(isErrorFresh(null, now)).toBe(true);
    expect(isErrorFresh('garbage', now)).toBe(true);
  });
});
