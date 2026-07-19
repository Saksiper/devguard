import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);

let tmpDir;

function loadModule() {
  delete require.cache[require.resolve('../../src/engine/blame-cache')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/blame-cache');
}

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-bc-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try {
    const db = require('../../src/engine/db');
    db.closeDb();
  } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/blame-cache')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

function createGitRepo() {
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
  return repoDir;
}

function commitFile(repoDir, name, content, msg) {
  fs.writeFileSync(path.join(repoDir, name), content, 'utf-8');
  execSync(`git add "${name}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoDir, stdio: 'pipe' });
  return execSync('git log -1 --format=%H', { cwd: repoDir, encoding: 'utf-8' }).trim();
}

describe('blame-cache.js — parseBlame', () => {
  it('parses porcelain format correctly', () => {
    const { parseBlame } = loadModule();
    const hashA = 'a'.repeat(40);
    const hashB = 'b'.repeat(40);
    const raw = [
      `${hashA} 1 1 1`,
      'author Test',
      'author-mail <test@test.com>',
      'author-time 1617235200',
      'author-tz +0000',
      'committer Test',
      'committer-mail <test@test.com>',
      'committer-time 1617235200',
      'committer-tz +0000',
      'summary Fix something',
      'filename test.js',
      '\tconst x = 1;',
      `${hashB} 2 2 1`,
      'author Test',
      'author-mail <test@test.com>',
      'author-time 1617235200',
      'author-tz +0000',
      'committer Test',
      'committer-mail <test@test.com>',
      'committer-time 1617235200',
      'committer-tz +0000',
      'summary Another fix',
      'filename test.js',
      '\tconst y = 2;',
    ].join('\n');

    const result = parseBlame(raw);
    expect(result).toHaveLength(2);
    expect(result[0].commitHash).toBe(hashA);
    expect(result[0].lineNo).toBe(1);
    expect(result[1].commitHash).toBe(hashB);
    expect(result[1].lineNo).toBe(2);
  });

  it('returns empty array for empty input', () => {
    const { parseBlame } = loadModule();
    expect(parseBlame('')).toEqual([]);
    expect(parseBlame(null)).toEqual([]);
    expect(parseBlame(undefined)).toEqual([]);
  });

  it('handles boundary commit hash (all zeros)', () => {
    const { parseBlame } = loadModule();
    const raw = '0000000000000000000000000000000000000000 1 1 1\nauthor Not Committed Yet\n\tuncommitted line';
    const result = parseBlame(raw);
    expect(result).toHaveLength(1);
    expect(result[0].commitHash).toBe('0000000000000000000000000000000000000000');
  });
});

describe('blame-cache.js — filterLines', () => {
  it('filters by start and end line', () => {
    const { filterLines } = loadModule();
    const data = [
      { lineNo: 1, commitHash: 'a' },
      { lineNo: 5, commitHash: 'b' },
      { lineNo: 10, commitHash: 'c' },
    ];
    expect(filterLines(data, 3, 8)).toEqual([{ lineNo: 5, commitHash: 'b' }]);
  });

  it('returns all when no range specified', () => {
    const { filterLines } = loadModule();
    const data = [{ lineNo: 1, commitHash: 'a' }];
    expect(filterLines(data, null, null)).toEqual(data);
  });
});

describe('blame-cache.js — getFileCommitHash (real git)', () => {
  it('returns commit hash for tracked file', () => {
    const { getFileCommitHash } = loadModule();
    const repoDir = createGitRepo();
    commitFile(repoDir, 'test.js', 'hello', 'init');
    const hash = getFileCommitHash('test.js', repoDir);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null for untracked file', () => {
    const { getFileCommitHash } = loadModule();
    const repoDir = createGitRepo();
    commitFile(repoDir, 'tracked.js', 'hi', 'init');
    fs.writeFileSync(path.join(repoDir, 'untracked.js'), 'hello');
    const hash = getFileCommitHash('untracked.js', repoDir);
    expect(hash).toBeNull();
  });

  it('returns null for non-git directory', () => {
    const { getFileCommitHash } = loadModule();
    const noGitDir = path.join(tmpDir, 'nogit');
    fs.mkdirSync(noGitDir);
    fs.writeFileSync(path.join(noGitDir, 'test.js'), 'hi');
    const hash = getFileCommitHash('test.js', noGitDir);
    expect(hash).toBeNull();
  });
});

describe('blame-cache.js — getBlame (real git)', () => {
  it('returns blame data for tracked file', () => {
    const { getBlame } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    const content = 'line1\nline2\nline3\n';
    const hash = commitFile(repoDir, 'test.js', content, 'init');

    const result = getBlame(db, 'test.js', 1, 3, repoDir);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].commitHash).toBe(hash);
  });

  it('caches blame data in SQLite', () => {
    const { getBlame } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    commitFile(repoDir, 'test.js', 'line1\nline2\n', 'init');

    getBlame(db, 'test.js', 1, 2, repoDir);
    const cached = db.getBlameCache('test.js', execSync('git log -1 --format=%H -- test.js', { cwd: repoDir, encoding: 'utf-8' }).trim());
    expect(cached).not.toBeNull();
    expect(cached.blame_data).toBeTruthy();
  });

  it('returns cached data on second call', () => {
    const { getBlame } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    commitFile(repoDir, 'test.js', 'line1\nline2\n', 'init');

    const first = getBlame(db, 'test.js', 1, 2, repoDir);
    const second = getBlame(db, 'test.js', 1, 2, repoDir);
    expect(first).toEqual(second);
  });

  it('returns empty array for untracked file', () => {
    const { getBlame } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    commitFile(repoDir, 'tracked.js', 'hi', 'init');
    fs.writeFileSync(path.join(repoDir, 'untracked.js'), 'hello');

    const result = getBlame(db, 'untracked.js', 1, 1, repoDir);
    expect(result).toEqual([]);
  });
});

describe('blame-cache.js — invalidation', () => {
  it('invalidateFile removes cache for specific file', () => {
    const { getBlame, invalidateFile } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    commitFile(repoDir, 'test.js', 'line1\n', 'init');

    getBlame(db, 'test.js', 1, 1, repoDir);
    invalidateFile(db, 'test.js');

    const hash = execSync('git log -1 --format=%H -- test.js', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(db.getBlameCache('test.js', hash)).toBeNull();
  });

  it('flushAll removes all cache entries', () => {
    const { getBlame, flushAll } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    commitFile(repoDir, 'a.js', 'line1\n', 'init a');
    commitFile(repoDir, 'b.js', 'line1\n', 'init b');

    getBlame(db, 'a.js', 1, 1, repoDir);
    getBlame(db, 'b.js', 1, 1, repoDir);
    flushAll(db);

    const hashA = execSync('git log -1 --format=%H -- a.js', { cwd: repoDir, encoding: 'utf-8' }).trim();
    const hashB = execSync('git log -1 --format=%H -- b.js', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(db.getBlameCache('a.js', hashA)).toBeNull();
    expect(db.getBlameCache('b.js', hashB)).toBeNull();
  });
});

describe('blame-cache.js — QA #3: corrupt cache re-fetch', () => {
  it('re-fetches when cached blame_data is invalid JSON', () => {
    const { getBlame } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    const hash = commitFile(repoDir, 'test.js', 'line1\nline2\n', 'init');

    db.insertBlameCache('test.js', hash, 'NOT VALID JSON{{{');
    const result = getBlame(db, 'test.js', 1, 2, repoDir);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].commitHash).toBe(hash);
  });
});

describe('blame-cache.js — security: no shell injection via filePath', () => {
  // Regression for the OS command injection: filePath was interpolated into an
  // execSync shell string. A crafted path with shell metacharacters must NOT run
  // a command. cmd.exe uses '&' as a separator; POSIX sh uses ';'. The injected
  // command tries to create a canary file in cwd — after the execFileSync fix it
  // is passed to git as a literal pathspec, so the canary must never appear.
  it('does not execute injected shell commands in the file path', () => {
    const { getFileCommitHash } = loadModule();
    const repoDir = createGitRepo();
    commitFile(repoDir, 'real.js', 'hello', 'init');

    const payload = process.platform === 'win32'
      ? 'nope" & echo pwned> CANARY.txt & rem '
      : 'nope"; echo pwned > CANARY.txt #';

    const result = getFileCommitHash(payload, repoDir);

    // Injection neutralized: no command ran, git found no matching pathspec.
    expect(fs.existsSync(path.join(repoDir, 'CANARY.txt'))).toBe(false);
    expect(result).toBeNull();
  });
});

describe('blame-cache.js — QA #7: binary file', () => {
  it('returns empty array for binary file (git blame fails or returns empty)', () => {
    const { getBlame } = loadModule();
    const dbMod = loadDb();
    const db = dbMod.getDb(tmpDir);
    const repoDir = createGitRepo();
    const binContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    fs.writeFileSync(path.join(repoDir, 'image.png'), binContent);
    execSync('git add image.png', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit -m "add binary"', { cwd: repoDir, stdio: 'pipe' });

    const result = getBlame(db, 'image.png', 1, 1, repoDir);
    expect(Array.isArray(result)).toBe(true);
  });
});
