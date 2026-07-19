import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { normalizePath, normalizeProjectPath } = require('../../src/engine/normalize-path');

describe('normalizePath', () => {
  it('converts Windows backslash path to forward slash absolute path', () => {
    // Simulate a Windows-style relative path by using the OS separator
    const result = normalizePath('src\\engine\\db.js');
    expect(result).not.toContain('\\');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('resolves relative path to absolute forward slash path', () => {
    const result = normalizePath('some/relative/file.js');
    expect(result).not.toContain('\\');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('leaves already-absolute forward slash path unchanged (modulo cwd resolution)', () => {
    const abs = path.posix.join(process.cwd().replace(/\\/g, '/'), 'file.js');
    const result = normalizePath(abs);
    expect(result).not.toContain('\\');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith('file.js')).toBe(true);
  });

  it('removes trailing slash', () => {
    const result = normalizePath('some/dir/');
    expect(result.endsWith('/')).toBe(false);
    expect(result.endsWith('\\')).toBe(false);
  });

  it('returns null as-is', () => {
    expect(normalizePath(null)).toBe(null);
  });

  it('returns undefined as-is', () => {
    expect(normalizePath(undefined)).toBe(undefined);
  });

  it('returns empty string as-is', () => {
    expect(normalizePath('')).toBe('');
  });

  it('handles paths with spaces correctly', () => {
    const result = normalizePath('my folder/my file.js');
    expect(result).not.toContain('\\');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('my folder');
    expect(result).toContain('my file.js');
  });

  it('rejects null-byte injection paths', () => {
    expect(normalizePath('/safe/path\0/../../etc/passwd')).toBe('');
    expect(normalizePath('file\0.js')).toBe('');
  });

  it('rejects UNC paths (NTLM credential leak)', () => {
    expect(normalizePath('\\\\evil-server\\share\\file')).toBe('');
    expect(normalizePath('//evil-server/share/file')).toBe('');
  });

  // P1.3: NTFS ADS (Alternate Data Stream)
  it('rejects NTFS Alternate Data Stream paths', () => {
    expect(normalizePath('C:/project/file.txt:hidden')).toBe('');
    expect(normalizePath('C:/project/file.txt:$DATA')).toBe('');
  });

  // P1.3: DOS device names — reservation only exists on Windows. On POSIX these
  // are valid filenames, so the filter is platform-gated (CI runs ubuntu+windows).
  const onWin = process.platform === 'win32';
  const itWin = onWin ? it : it.skip;
  const itPosix = onWin ? it.skip : it;

  itWin('rejects DOS device names on Windows (CON, PRN, AUX, NUL)', () => {
    expect(normalizePath('CON')).toBe('');
    expect(normalizePath('PRN')).toBe('');
    expect(normalizePath('AUX')).toBe('');
    expect(normalizePath('NUL')).toBe('');
    expect(normalizePath('COM1')).toBe('');
    expect(normalizePath('LPT1')).toBe('');
  });

  itWin('rejects DOS device names with extension on Windows', () => {
    expect(normalizePath('CON.txt')).toBe('');
    expect(normalizePath('NUL.js')).toBe('');
  });

  itPosix('does NOT reject aux.js / con.py on POSIX (valid filenames there)', () => {
    expect(normalizePath('aux.js')).not.toBe('');
    expect(normalizePath('con.py')).not.toBe('');
    expect(normalizePath('nul.txt')).not.toBe('');
  });

  it('does NOT reject normal files that start with device-like prefix', () => {
    expect(normalizePath('CONSOLE.js')).not.toBe('');
    expect(normalizePath('NULLIFY.txt')).not.toBe('');
    expect(normalizePath('connection.js')).not.toBe('');
  });

  // P1.3: Windows long path prefix
  it('rejects Windows long path prefix', () => {
    expect(normalizePath('\\\\?\\C:\\Windows\\System32')).toBe('');
    expect(normalizePath('\\\\.\\PhysicalDrive0')).toBe('');
  });
});

describe('normalizeProjectPath', () => {
  it('resolves to absolute forward-slash path', () => {
    const result = normalizeProjectPath('some/project');
    expect(result).not.toContain('\\');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('converts Windows backslash path to forward slash', () => {
    const result = normalizeProjectPath('C:\\Users\\test\\project');
    expect(result).not.toContain('\\');
    expect(result).toContain('C:/');
  });

  it('returns null/undefined/empty as-is', () => {
    expect(normalizeProjectPath(null)).toBe(null);
    expect(normalizeProjectPath(undefined)).toBe(undefined);
    expect(normalizeProjectPath('')).toBe('');
  });

  it('produces consistent output for same directory with different separators', () => {
    const a = normalizeProjectPath('C:\\Users\\test\\project');
    const b = normalizeProjectPath('C:/Users/test/project');
    expect(a).toBe(b);
  });

  const onWin2 = process.platform === 'win32';
  (onWin2 ? it : it.skip)('canonicalizes drive-letter case so c:/ and C:/ collapse to one project_path', () => {
    // path.resolve preserves drive-letter case; without folding, a lowercase-drive
    // cwd split every DB lookup (case-sensitive =) from the uppercase one.
    const lower = normalizeProjectPath('c:/Users/test/proj');
    const upper = normalizeProjectPath('C:/Users/test/proj');
    expect(lower).toBe(upper);
    expect(lower.startsWith('C:/')).toBe(true);
  });
});
