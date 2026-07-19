import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { computeFileFingerprint, isNoteStale } = require('../../src/engine/file-fingerprint');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-fp-test-')); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* locked */ } });

describe('file-fingerprint — computeFileFingerprint', () => {
  it('returns a stable sha256 hex digest for an existing file', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'hello world');
    const h = computeFileFingerprint(f);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFileFingerprint(f)).toBe(h); // deterministic
  });

  it('changes when file content changes', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'v1');
    const h1 = computeFileFingerprint(f);
    fs.writeFileSync(f, 'v2');
    expect(computeFileFingerprint(f)).not.toBe(h1);
  });

  it('returns null for a missing file', () => {
    expect(computeFileFingerprint(path.join(tmpDir, 'nope.js'))).toBeNull();
  });

  it('returns null for an oversize file (> 2MB cap)', () => {
    const f = path.join(tmpDir, 'big.js');
    fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024, 0x61));
    expect(computeFileFingerprint(f)).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(computeFileFingerprint(null)).toBeNull();
    expect(computeFileFingerprint('')).toBeNull();
    expect(computeFileFingerprint(42)).toBeNull();
  });
});

describe('file-fingerprint — isNoteStale', () => {
  it('is false when the note has no source_file or fingerprint (old/unattributable note)', () => {
    expect(isNoteStale(null)).toBe(false);
    expect(isNoteStale({})).toBe(false);
    expect(isNoteStale({ source_file: '/x', code_fingerprint: null })).toBe(false);
    expect(isNoteStale({ source_file: null, code_fingerprint: 'abc' })).toBe(false);
  });

  it('is false when the file is unchanged since capture', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'stable content');
    const fp = computeFileFingerprint(f);
    expect(isNoteStale({ source_file: f, code_fingerprint: fp })).toBe(false);
  });

  it('is true when the file changed since capture', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'original');
    const fp = computeFileFingerprint(f);
    fs.writeFileSync(f, 'rewritten');
    expect(isNoteStale({ source_file: f, code_fingerprint: fp })).toBe(true);
  });

  it('is true when the file was deleted since capture', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'original');
    const fp = computeFileFingerprint(f);
    fs.rmSync(f);
    expect(isNoteStale({ source_file: f, code_fingerprint: fp })).toBe(true);
  });

  it('self-heals: not stale after the file is reverted to captured content', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'original');
    const fp = computeFileFingerprint(f);
    fs.writeFileSync(f, 'changed');
    fs.writeFileSync(f, 'original');
    expect(isNoteStale({ source_file: f, code_fingerprint: fp })).toBe(false);
  });

  it('is false (no false-alarm) when the file exists but is now unreadable/oversize', () => {
    const f = path.join(tmpDir, 'a.js');
    fs.writeFileSync(f, 'small');
    const fp = computeFileFingerprint(f);
    fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024, 0x62)); // now over cap
    expect(isNoteStale({ source_file: f, code_fingerprint: fp })).toBe(false);
  });
});
