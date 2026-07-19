import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;

function loadModule() {
  delete require.cache[require.resolve('../../src/engine/line-resolver')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/line-resolver');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-lr-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name, content) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('line-resolver.js — resolveLines', () => {
  it('returns null for null oldString', () => {
    const { resolveLines } = loadModule();
    expect(resolveLines('/any/file', null)).toBeNull();
  });

  it('returns null for empty oldString', () => {
    const { resolveLines } = loadModule();
    expect(resolveLines('/any/file', '')).toBeNull();
  });

  it('returns null for undefined oldString', () => {
    const { resolveLines } = loadModule();
    expect(resolveLines('/any/file', undefined)).toBeNull();
  });

  it('returns null when file does not exist', () => {
    const { resolveLines } = loadModule();
    expect(resolveLines('/nonexistent/file.js', 'something')).toBeNull();
  });

  it('returns empty array when no match found', () => {
    const { resolveLines } = loadModule();
    const filePath = writeFile('test.js', 'line1\nline2\nline3\n');
    expect(resolveLines(filePath, 'notfound')).toEqual([]);
  });

  it('finds single-line match at line 1', () => {
    const { resolveLines } = loadModule();
    const filePath = writeFile('test.js', 'const x = 1;\nconst y = 2;\n');
    const result = resolveLines(filePath, 'const x = 1;');
    expect(result).toEqual([{ start: 1, end: 1 }]);
  });

  it('finds single-line match at line 3', () => {
    const { resolveLines } = loadModule();
    const filePath = writeFile('test.js', 'a\nb\nconst target = true;\nd\n');
    const result = resolveLines(filePath, 'const target = true;');
    expect(result).toEqual([{ start: 3, end: 3 }]);
  });

  it('finds multi-line match', () => {
    const { resolveLines } = loadModule();
    const content = 'line1\nfunction foo() {\n  return 42;\n}\nline5\n';
    const filePath = writeFile('test.js', content);
    const result = resolveLines(filePath, 'function foo() {\n  return 42;\n}');
    expect(result).toEqual([{ start: 2, end: 4 }]);
  });

  it('finds multiple matches', () => {
    const { resolveLines } = loadModule();
    const content = 'abc\ndef\nabc\nghi\nabc\n';
    const filePath = writeFile('test.js', content);
    const result = resolveLines(filePath, 'abc');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ start: 1, end: 1 });
    expect(result[1]).toEqual({ start: 3, end: 3 });
    expect(result[2]).toEqual({ start: 5, end: 5 });
  });

  it('handles Windows line endings (\\r\\n)', () => {
    const { resolveLines } = loadModule();
    const content = 'line1\r\nline2\r\ntarget\r\nline4\r\n';
    const filePath = writeFile('test.js', content);
    const result = resolveLines(filePath, 'target');
    expect(result).toEqual([{ start: 3, end: 3 }]);
  });

  it('handles large file (1000+ lines)', () => {
    const { resolveLines } = loadModule();
    const lines = [];
    for (let i = 1; i <= 1000; i++) lines.push(`line ${i}`);
    lines.push('NEEDLE');
    const filePath = writeFile('big.js', lines.join('\n'));
    const result = resolveLines(filePath, 'NEEDLE');
    expect(result).toEqual([{ start: 1001, end: 1001 }]);
  });

  it('handles large multi-line oldString (100+ lines)', () => {
    const { resolveLines } = loadModule();
    const bigOld = Array.from({ length: 100 }, (_, i) => `  step${i}();`).join('\n');
    const content = 'header\n' + bigOld + '\nfooter\n';
    const filePath = writeFile('big.js', content);
    const result = resolveLines(filePath, bigOld);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(2);
    expect(result[0].end).toBe(101);
  });

  it('handles file with no trailing newline', () => {
    const { resolveLines } = loadModule();
    const filePath = writeFile('test.js', 'only line');
    const result = resolveLines(filePath, 'only line');
    expect(result).toEqual([{ start: 1, end: 1 }]);
  });

  it('handles empty file', () => {
    const { resolveLines } = loadModule();
    const filePath = writeFile('empty.js', '');
    expect(resolveLines(filePath, 'anything')).toEqual([]);
  });

  it('QA #6: Turkish characters — correct line numbers', () => {
    const { resolveLines } = loadModule();
    const content = 'const değişken = 1;\nconst özellik = true;\nconst şifre = "gizli";\n';
    const filePath = writeFile('turkce.js', content);
    const result = resolveLines(filePath, 'const özellik = true;');
    expect(result).toEqual([{ start: 2, end: 2 }]);
  });

  it('QA #6: Turkish İ/ı characters', () => {
    const { resolveLines } = loadModule();
    const content = 'İstanbul\nAnkara\nİzmir\n';
    const filePath = writeFile('sehirler.txt', content);
    const result = resolveLines(filePath, 'İzmir');
    expect(result).toEqual([{ start: 3, end: 3 }]);
  });
});
