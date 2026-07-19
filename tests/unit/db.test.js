import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-db-test-'));
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
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: WAL/SHM files may still be locked briefly
    }
  }
});

function freshDb(projectPath) {
  const db = loadDb();
  return db.getDb(projectPath || '/test/project');
}

describe('db.js — Database initialization', () => {
  it('creates DB file on first access', () => {
    freshDb();
    const dbFile = path.join(tmpDir, 'devguard.db');
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it('runs migration v1 idempotently', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    db.closeDb();
    // Re-open same DB — migrations should not fail
    db.openDb();
    const proxy2 = db.getDb('/test/project');
    const session = proxy2.getLatestSession();
    expect(session.session_id).toBe('sess-1');
  });

  it('enables WAL mode', () => {
    const db = loadDb();
    const raw = db.openDb();
    const mode = raw.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('enables foreign_keys', () => {
    const db = loadDb();
    const raw = db.openDb();
    const fk = raw.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });
});

describe('db.js — changes CRUD', () => {
  it('inserts and retrieves a change', () => {
    const proxy = freshDb();
    const id = proxy.insertChange({ file: 'test.js', description: 'test change' });
    expect(id).toBeGreaterThan(0);
    const rows = proxy.getChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0].file).toBe('test.js');
    expect(rows[0].project_path).toBe('/test/project');
  });

  it('filters changes by session_id', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'a.js', session_id: 's1' });
    proxy.insertChange({ file: 'b.js', session_id: 's2' });
    const rows = proxy.getChanges({ session_id: 's1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].file).toBe('a.js');
  });

  it('filters changes by file', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'a.js' });
    proxy.insertChange({ file: 'b.js' });
    const rows = proxy.getChanges({ file: 'b.js' });
    expect(rows).toHaveLength(1);
  });

  it('respects limit', () => {
    const proxy = freshDb();
    for (let i = 0; i < 5; i++) proxy.insertChange({ file: `f${i}.js` });
    const rows = proxy.getChanges({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('returns change count', () => {
    const proxy = freshDb();
    expect(proxy.getChangeCount()).toBe(0);
    proxy.insertChange({ file: 'a.js' });
    proxy.insertChange({ file: 'b.js' });
    expect(proxy.getChangeCount()).toBe(2);
  });
});

describe('db.js — issues CRUD', () => {
  it('inserts and retrieves an issue', () => {
    const proxy = freshDb();
    const id = proxy.insertIssue({ title: 'OAuth timeout' });
    expect(id).toBeGreaterThan(0);
    const rows = proxy.getIssues();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('OAuth timeout');
    expect(rows[0].status).toBe('open');
  });

  it('filters issues by status', () => {
    const proxy = freshDb();
    proxy.insertIssue({ title: 'open issue' });
    proxy.insertIssue({ title: 'closed issue', status: 'closed' });
    const open = proxy.getIssues({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('open issue');
  });
});

describe('db.js — error_outputs CRUD', () => {
  it('inserts and retrieves an error output', () => {
    const proxy = freshDb();
    const id = proxy.insertErrorOutput({ error_string: 'FAIL', error_hash: 'abc123' });
    expect(id).toBeGreaterThan(0);
    const rows = proxy.getErrorOutputs();
    expect(rows).toHaveLength(1);
    expect(rows[0].error_hash).toBe('abc123');
  });

  it('filters by error_hash', () => {
    const proxy = freshDb();
    proxy.insertErrorOutput({ error_string: 'a', error_hash: 'h1' });
    proxy.insertErrorOutput({ error_string: 'b', error_hash: 'h2' });
    const rows = proxy.getErrorOutputs({ error_hash: 'h1' });
    expect(rows).toHaveLength(1);
  });
});

describe('db.js — sessions CRUD', () => {
  it('inserts and retrieves latest session', () => {
    const proxy = freshDb();
    proxy.insertSession('sess-abc');
    const latest = proxy.getLatestSession();
    expect(latest.session_id).toBe('sess-abc');
    expect(latest.project_path).toBe('/test/project');
  });

  it('getLatestSession returns most recent', () => {
    const proxy = freshDb();
    proxy.insertSession('sess-1');
    proxy.insertSession('sess-2');
    const latest = proxy.getLatestSession();
    expect(latest.session_id).toBe('sess-2');
  });

  it('getLatestSession returns null when no sessions', () => {
    const proxy = freshDb();
    expect(proxy.getLatestSession()).toBeNull();
  });

  it('getSessionCount works', () => {
    const proxy = freshDb();
    expect(proxy.getSessionCount()).toBe(0);
    proxy.insertSession('s1');
    proxy.insertSession('s2');
    expect(proxy.getSessionCount()).toBe(2);
  });
});

describe('db.js — protected_zones CRUD', () => {
  it('inserts and retrieves a protected zone', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'test' });
    const changeId = proxy.insertChange({ file: 'x.js' });
    const zoneId = proxy.insertProtectedZone({
      issue_id: issueId,
      change_id: changeId,
      file: 'x.js',
      protected_commit: 'abc123',
      reason: 'OAuth fix',
    });
    expect(zoneId).toBeGreaterThan(0);
    const zones = proxy.getProtectedZones();
    expect(zones).toHaveLength(1);
    expect(zones[0].protected_commit).toBe('abc123');
  });

  it('filters by file', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'test' });
    const c1 = proxy.insertChange({ file: 'a.js' });
    const c2 = proxy.insertChange({ file: 'b.js' });
    proxy.insertProtectedZone({ issue_id: issueId, change_id: c1, file: 'a.js' });
    proxy.insertProtectedZone({ issue_id: issueId, change_id: c2, file: 'b.js' });
    const zones = proxy.getProtectedZones({ file: 'a.js' });
    expect(zones).toHaveLength(1);
  });
});

describe('db.js — blame_cache', () => {
  it('inserts and retrieves blame cache', () => {
    const proxy = freshDb();
    proxy.insertBlameCache('/test/file.js', 'abc123', '{"lines":[]}');
    const cached = proxy.getBlameCache('/test/file.js', 'abc123');
    expect(cached).not.toBeNull();
    expect(cached.blame_data).toBe('{"lines":[]}');
  });

  it('returns null for cache miss', () => {
    const proxy = freshDb();
    expect(proxy.getBlameCache('none.js', 'xxx')).toBeNull();
  });

  it('deletes old entries by TTL', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    const raw = db.openDb();
    raw.prepare(
      "INSERT INTO blame_cache (project_path, file_path, commit_hash, blame_data, created_at) VALUES (?, ?, ?, ?, datetime('now', '-10 days'))"
    ).run('/test/project', 'old.js', 'old', '{}');
    proxy.insertBlameCache('new.js', 'new', '{}');
    const deleted = proxy.deleteOldBlameCacheEntries(7);
    expect(deleted).toBe(1);
    expect(proxy.getBlameCache('new.js', 'new')).not.toBeNull();
    expect(proxy.getBlameCache('old.js', 'old')).toBeNull();
  });
});

describe('db.js — FTS5', () => {
  it('indexes inserted changes for full-text search', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'test.js', description: 'OAuth token expired handler' });
    proxy.insertChange({ file: 'test.js', description: 'database connection pool' });
    const results = proxy.searchFts('OAuth');
    expect(results).toHaveLength(1);
    expect(results[0].description).toBe('OAuth token expired handler');
  });

  it('returns empty for unmatched query', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'test.js', description: 'hello world' });
    const results = proxy.searchFts('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('returns empty array on invalid FTS5 syntax instead of crashing', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'test.js', description: 'hello' });
    expect(proxy.searchFts('NEAR(a b)')).toEqual([]);
    expect(proxy.searchFts('')).toEqual([]);
    expect(proxy.searchFts('"unclosed')).toEqual([]);
  });
});

describe('db.js — FIFO', () => {
  it('exact boundary: no deletion when count equals maxEntries', () => {
    const proxy = freshDb();
    for (let i = 0; i < 5; i++) proxy.insertChange({ file: `f${i}.js` });
    expect(proxy.runFifo(5)).toBe(0);
    expect(proxy.getChangeCount()).toBe(5);
  });

  it('deletes oldest entries when over limit', () => {
    const proxy = freshDb();
    for (let i = 0; i < 5; i++) proxy.insertChange({ file: `f${i}.js` });
    const deleted = proxy.runFifo(3);
    expect(deleted).toBe(2);
    expect(proxy.getChangeCount()).toBe(3);
  });

  it('does nothing when under limit', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'a.js' });
    const deleted = proxy.runFifo(10);
    expect(deleted).toBe(0);
  });

  it('preserves protected_zones-linked changes', () => {
    const proxy = freshDb();
    for (let i = 0; i < 5; i++) proxy.insertChange({ file: `f${i}.js` });

    const issueId = proxy.insertIssue({ title: 'protect this' });
    const changes = proxy.getChanges();
    const oldestId = changes[changes.length - 1].id;
    proxy.insertProtectedZone({
      issue_id: issueId,
      change_id: oldestId,
      file: 'f0.js',
    });

    proxy.runFifo(3);
    const remaining = proxy.getChanges();
    const remainingIds = remaining.map(r => r.id);
    expect(remainingIds).toContain(Number(oldestId));
  });

  it('deletes related error_outputs when FIFO runs', () => {
    const proxy = freshDb();
    const changeId = proxy.insertChange({ file: 'test.js' });
    proxy.insertErrorOutput({ change_id: Number(changeId), error_string: 'fail', error_hash: 'h1' });
    for (let i = 0; i < 5; i++) proxy.insertChange({ file: `pad${i}.js` });
    proxy.runFifo(3);
    const errors = proxy.getErrorOutputs({ error_hash: 'h1' });
    expect(errors).toHaveLength(0);
  });

  it('does not delete below limit when all deletable records are protected', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'protect all' });
    for (let i = 0; i < 5; i++) {
      const cid = proxy.insertChange({ file: `f${i}.js` });
      proxy.insertProtectedZone({ issue_id: issueId, change_id: cid, file: `f${i}.js` });
    }
    const deleted = proxy.runFifo(2);
    expect(deleted).toBe(0);
    expect(proxy.getChangeCount()).toBe(5);
  });
});

describe('db.js — sanitization', () => {
  it('sanitizes description on insert', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'test.js', description: 'key is sk-abcdefghijklmnopqrstuvwxyz1234' });
    const rows = proxy.getChanges();
    expect(rows[0].description).toContain('[REDACTED_API_KEY]');
    expect(rows[0].description).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
  });

  it('sanitizes error_string on insert', () => {
    const proxy = freshDb();
    proxy.insertErrorOutput({
      error_string: 'connection: postgresql://user:pass@localhost/db',
      error_hash: 'h1',
    });
    const rows = proxy.getErrorOutputs();
    expect(rows[0].error_string).toContain('[REDACTED_CONN_STRING]');
  });

  it('sanitizes protected_zone reason on insert', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'test' });
    const changeId = proxy.insertChange({ file: 'x.js' });
    proxy.insertProtectedZone({
      issue_id: issueId,
      change_id: changeId,
      file: 'x.js',
      reason: 'Used redis://default:secret@host:6379',
    });
    const zones = proxy.getProtectedZones();
    expect(zones[0].reason).toContain('[REDACTED_CONN_STRING]');
  });
});

describe('db.js — orphan cleanup', () => {
  it('getDistinctProjectPaths returns all projects', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/a');
    const proxyB = db.getDb('/project/b');
    proxyA.insertSession('s1');
    proxyB.insertSession('s2');
    const paths = proxyA.getDistinctProjectPaths();
    expect(paths).toContain('/project/a');
    expect(paths).toContain('/project/b');
  });

  it('deleteByProjectPath removes only target project', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/a');
    const proxyB = db.getDb('/project/b');
    proxyA.insertSession('s1');
    proxyA.insertChange({ file: 'a.js' });
    proxyB.insertSession('s2');
    proxyB.insertChange({ file: 'b.js' });

    proxyA.deleteByProjectPath('/project/a');

    expect(proxyA.getChanges()).toHaveLength(0);
    expect(proxyA.getLatestSession()).toBeNull();
    expect(proxyB.getChanges()).toHaveLength(1);
    expect(proxyB.getLatestSession()).not.toBeNull();
  });

  it('deleteByProjectPath also cleans blame_cache', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/a');
    const proxyB = db.getDb('/project/b');
    proxyA.insertBlameCache('file.js', 'abc', '{}');
    proxyB.insertBlameCache('file.js', 'abc', '{}');

    proxyA.deleteByProjectPath('/project/a');

    expect(proxyA.getBlameCache('file.js', 'abc')).toBeNull();
    expect(proxyB.getBlameCache('file.js', 'abc')).not.toBeNull();
  });
});

describe('db.js — input validation', () => {
  it('getDb throws on empty string', () => {
    const db = loadDb();
    expect(() => db.getDb('')).toThrow('non-empty projectPath');
  });

  it('getDb throws on null/undefined', () => {
    const db = loadDb();
    expect(() => db.getDb(null)).toThrow('non-empty projectPath');
    expect(() => db.getDb(undefined)).toThrow('non-empty projectPath');
  });

  it('SQL injection via project_path is harmless (parameterized queries)', () => {
    const db = loadDb();
    const malicious = "'; DROP TABLE changes; --";
    const proxy = db.getDb(malicious);
    proxy.insertSession('s1');
    proxy.insertChange({ file: 'test.js', description: 'safe' });
    const changes = proxy.getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].project_path).toBe(malicious);
    // Verify changes table still exists
    const proxy2 = db.getDb('/other');
    expect(() => proxy2.getChanges()).not.toThrow();
  });
});

describe('db.js — fallback path', () => {
  afterEach(() => {
    delete process.env.DEVGUARD_PLUGINS_DIR;
  });

  it('uses homedir fallback when CLAUDE_PLUGIN_DATA is not set and no plugin DBs exist', () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    process.env.DEVGUARD_PLUGINS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-empty-plugins-'));
    const db = loadDb();
    const dbPath = db.getDbPath();
    expect(dbPath).toContain('.devguard');
    expect(dbPath).toContain('devguard.db');
  });

  it('prefers the canonical marketplace DB over an inline variant EVEN when inline is newer (no mtime roulette)', () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-plugins-'));
    process.env.DEVGUARD_PLUGINS_DIR = base;
    const inlineDir = path.join(base, 'devguard-inline');
    const marketDir = path.join(base, 'devguard-devguard-marketplace');
    fs.mkdirSync(inlineDir);
    fs.mkdirSync(marketDir);
    fs.writeFileSync(path.join(inlineDir, 'devguard.db'), 'x');
    fs.writeFileSync(path.join(marketDir, 'devguard.db'), 'x');
    // Inline is the NEWER file — the old mtime rule would pick it; deterministic wins.
    fs.utimesSync(path.join(marketDir, 'devguard.db'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.utimesSync(path.join(inlineDir, 'devguard.db'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    const db = loadDb();
    expect(db.getDbPath()).toBe(path.join(marketDir, 'devguard.db'));
  });

  it('ignores a pre-merge inline rename (still an inline variant) and a junction, picking marketplace', () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-plugins-'));
    process.env.DEVGUARD_PLUGINS_DIR = base;
    for (const [dir, when] of [
      ['devguard-devguard-marketplace', new Date(2020, 0, 1)],
      ['devguard-inline', new Date(2026, 0, 1)],
      ['devguard-inline-premerge-20260719', new Date(2026, 5, 1)],
    ]) {
      const d = path.join(base, dir);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'devguard.db'), 'x');
      fs.utimesSync(path.join(d, 'devguard.db'), when, when);
    }
    const db = loadDb();
    expect(db.getDbPath()).toBe(path.join(base, 'devguard-devguard-marketplace', 'devguard.db'));
  });

  it('never selects a backup directory even if it holds a devguard.db', () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-plugins-'));
    process.env.DEVGUARD_PLUGINS_DIR = base;
    const backupDir = path.join(base, 'backup-20260719-dbmerge');
    const marketDir = path.join(base, 'devguard-devguard-marketplace');
    fs.mkdirSync(backupDir);
    fs.mkdirSync(marketDir);
    fs.writeFileSync(path.join(backupDir, 'devguard.db'), 'x');
    fs.writeFileSync(path.join(marketDir, 'devguard.db'), 'x');
    fs.utimesSync(path.join(backupDir, 'devguard.db'), new Date(2026, 6, 1), new Date(2026, 6, 1));
    fs.utimesSync(path.join(marketDir, 'devguard.db'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const db = loadDb();
    expect(db.getDbPath()).toBe(path.join(marketDir, 'devguard.db'));
  });

  it('falls back to the single candidate when only an inline DB exists (no canonical)', () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-plugins-'));
    process.env.DEVGUARD_PLUGINS_DIR = base;
    const inlineDir = path.join(base, 'devguard-inline');
    fs.mkdirSync(inlineDir);
    fs.writeFileSync(path.join(inlineDir, 'devguard.db'), 'x');
    const db = loadDb();
    expect(db.getDbPath()).toBe(path.join(inlineDir, 'devguard.db'));
  });
});

describe('db.js — corrupt DB file', () => {
  it('throws on corrupt/truncated DB file (better-sqlite3 rejects it)', () => {
    const dbFile = path.join(tmpDir, 'devguard.db');
    fs.writeFileSync(dbFile, 'this is not a sqlite database file');
    expect(() => loadDb().openDb()).toThrow();
  });
});

describe('db.js — insertChange missing required field', () => {
  it('throws SQLite constraint error when file field is missing', () => {
    const proxy = freshDb();
    expect(() => proxy.insertChange({ description: 'no file field' })).toThrow();
  });

  it('throws when file is explicitly null', () => {
    const proxy = freshDb();
    expect(() => proxy.insertChange({ file: null, description: 'null file' })).toThrow();
  });
});

describe('db.js — FIFO edge cases', () => {
  it('runFifo(0) deletes all non-protected entries', () => {
    const proxy = freshDb();
    for (let i = 0; i < 3; i++) proxy.insertChange({ file: `f${i}.js` });
    const deleted = proxy.runFifo(0);
    expect(deleted).toBe(3);
    expect(proxy.getChangeCount()).toBe(0);
  });

  it('runFifo(0) preserves protected entries', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'protect' });
    const protectedId = proxy.insertChange({ file: 'protected.js' });
    proxy.insertProtectedZone({ issue_id: issueId, change_id: protectedId, file: 'protected.js' });
    for (let i = 0; i < 3; i++) proxy.insertChange({ file: `f${i}.js` });

    proxy.runFifo(0);
    expect(proxy.getChangeCount()).toBe(1);
    const remaining = proxy.getChanges();
    expect(remaining[0].file).toBe('protected.js');
  });
});

describe('db.js — large text + FTS5', () => {
  it('handles 100KB text INSERT and FTS5 indexing without error', () => {
    const proxy = freshDb();
    const bigText = 'keyword_sentinel ' + 'x'.repeat(100_000);
    const start = Date.now();
    const id = proxy.insertChange({ file: 'big.js', description: bigText });
    const elapsed = Date.now() - start;
    expect(id).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);

    const results = proxy.searchFts('keyword_sentinel');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(Number(id));
  });
});

describe('db.js — platform path edge cases', () => {
  it('Windows backslash paths: insert and retrieve correctly', () => {
    const db = loadDb();
    const winProxy = db.getDb('C:\\Users\\umut\\project');
    winProxy.insertSession('s1');
    winProxy.insertChange({ file: 'app.js', description: 'windows test' });
    expect(winProxy.getChanges()).toHaveLength(1);
    expect(winProxy.getLatestSession().project_path).toBe('C:/Users/umut/project');
  });

  it('Windows and Unix paths are isolated (not confused)', () => {
    const db = loadDb();
    const winProxy = db.getDb('C:\\Users\\umut\\project');
    const unixProxy = db.getDb('/home/umut/project');
    winProxy.insertChange({ file: 'a.js' });
    unixProxy.insertChange({ file: 'b.js' });
    expect(winProxy.getChanges()).toHaveLength(1);
    expect(winProxy.getChanges()[0].file).toBe('a.js');
    expect(unixProxy.getChanges()).toHaveLength(1);
    expect(unixProxy.getChanges()[0].file).toBe('b.js');
  });

  it('Turkish characters in path: insert and retrieve correctly', () => {
    const db = loadDb();
    const proxy = db.getDb('/home/kullanıcı/proje-şöyle');
    proxy.insertSession('s1');
    proxy.insertChange({ file: 'test.js', description: 'türkçe path test' });
    expect(proxy.getChanges()).toHaveLength(1);
    expect(proxy.getLatestSession().project_path).toBe('/home/kullanıcı/proje-şöyle');
  });

  it('Turkish characters in FTS5 description: searchable', () => {
    const db = loadDb();
    const proxy = db.getDb('/home/kullanıcı/proje');
    proxy.insertChange({ file: 'test.js', description: 'çember tespiti şüpheli döngü' });
    const results = proxy.searchFts('döngü');
    expect(results).toHaveLength(1);
  });

  it('spaces in path: insert and retrieve correctly', () => {
    const db = loadDb();
    const proxy = db.getDb('C:\\My Projects\\dev guard\\project');
    proxy.insertSession('s1');
    proxy.insertChange({ file: 'test.js' });
    expect(proxy.getChanges()).toHaveLength(1);
    expect(proxy.getLatestSession().project_path).toBe('C:/My Projects/dev guard/project');
  });
});

describe('db.js — path traversal isolation', () => {
  it('../ path does not cross-pollute with resolved path', () => {
    const db = loadDb();
    const proxyA = db.getDb('/projects/alpha');
    const proxyTraversal = db.getDb('/projects/alpha/../beta');
    proxyA.insertChange({ file: 'a.js', description: 'alpha data' });
    proxyTraversal.insertChange({ file: 'b.js', description: 'traversal data' });

    expect(proxyA.getChanges()).toHaveLength(1);
    expect(proxyA.getChanges()[0].file).toBe('a.js');
    expect(proxyTraversal.getChanges()).toHaveLength(1);
    expect(proxyTraversal.getChanges()[0].file).toBe('b.js');
  });

  it('getDb stores raw path as-is (no normalization)', () => {
    const db = loadDb();
    const proxy = db.getDb('/projects/../other');
    proxy.insertSession('s1');
    const session = proxy.getLatestSession();
    expect(session.project_path).toBe('/projects/../other');
  });
});

describe('db.js — V3 migration: pending_summary', () => {
  it('sessions table has pending_summary column after migration', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    const session = proxy.getLatestSession();
    expect(session).toHaveProperty('pending_summary');
    expect(session.pending_summary).toBeNull();
  });

  it('setPendingSummary writes and consumePendingSummary reads + clears', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    proxy.setPendingSummary('s1', 'DevGuard Ozet: test');
    const consumed = proxy.consumePendingSummary('s1');
    expect(consumed).toBe('DevGuard Ozet: test');
    const again = proxy.consumePendingSummary('s1');
    expect(again).toBeNull();
  });

  it('consumePendingSummary returns null when no pending summary', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    expect(proxy.consumePendingSummary('s1')).toBeNull();
  });

  it('setPendingSummary overwrites previous pending summary', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    proxy.setPendingSummary('s1', 'first');
    proxy.setPendingSummary('s1', 'second');
    expect(proxy.consumePendingSummary('s1')).toBe('second');
  });
});

describe('db.js — V3 protection helper methods', () => {
  it('hasProtectedFile returns true when protection exists', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'OAuth fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      protected_commit: 'abc123', temp_protection: 0,
    });
    expect(proxy.hasProtectedFile('auth.js')).toBe(true);
  });

  it('hasProtectedFile returns false when no protection', () => {
    const proxy = freshDb();
    expect(proxy.hasProtectedFile('noprotect.js')).toBe(false);
  });

  it('getProtectedCommitsForFile returns distinct commits', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const c1 = proxy.insertChange({ file: 'auth.js' });
    const c2 = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: c1, file: 'auth.js',
      protected_commit: 'abc123', temp_protection: 0,
    });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: c2, file: 'auth.js',
      protected_commit: 'abc123', temp_protection: 0,
    });
    const commits = proxy.getProtectedCommitsForFile('auth.js');
    expect(commits).toEqual(['abc123']);
  });

  it('getProtectedCommitsForFile excludes temp protections', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      temp_protection: 1,
    });
    expect(proxy.getProtectedCommitsForFile('auth.js')).toEqual([]);
  });

  it('getTempProtectionsForFile returns temp protections', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      temp_lines_start: 10, temp_lines_end: 20, temp_protection: 1,
    });
    const temps = proxy.getTempProtectionsForFile('auth.js');
    expect(temps).toHaveLength(1);
    expect(temps[0].temp_lines_start).toBe(10);
  });

  it('promoteProtection upgrades temp to permanent', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      temp_lines_start: 10, temp_lines_end: 20, temp_protection: 1,
    });
    const promoted = proxy.promoteProtection('def456', ['auth.js']);
    expect(promoted).toBe(1);
    const commits = proxy.getProtectedCommitsForFile('auth.js');
    expect(commits).toEqual(['def456']);
    expect(proxy.getTempProtectionsForFile('auth.js')).toHaveLength(0);
  });

  it('promoteProtection ignores files not in list', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js', temp_protection: 1,
    });
    const promoted = proxy.promoteProtection('def456', ['other.js']);
    expect(promoted).toBe(0);
    expect(proxy.getTempProtectionsForFile('auth.js')).toHaveLength(1);
  });

  it('invalidateBlameCacheFile removes entries for specific file', () => {
    const proxy = freshDb();
    proxy.insertBlameCache('auth.js', 'abc123', '[]');
    proxy.insertBlameCache('utils.js', 'def456', '[]');
    proxy.invalidateBlameCacheFile('auth.js');
    expect(proxy.getBlameCache('auth.js', 'abc123')).toBeNull();
    expect(proxy.getBlameCache('utils.js', 'def456')).not.toBeNull();
  });

  it('flushBlameCache removes all entries for project', () => {
    const proxy = freshDb();
    proxy.insertBlameCache('a.js', 'abc', '[]');
    proxy.insertBlameCache('b.js', 'def', '[]');
    proxy.flushBlameCache();
    expect(proxy.getBlameCache('a.js', 'abc')).toBeNull();
    expect(proxy.getBlameCache('b.js', 'def')).toBeNull();
  });

  it('updateIssueFixChange links change to issue without changing status', () => {
    const proxy = freshDb();
    const issueId = proxy.insertIssue({ title: 'OAuth bug', status: 'open' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.updateIssueFixChange(issueId, changeId);
    const issues = proxy.getIssues({ status: 'open' });
    expect(issues).toHaveLength(1);
    expect(Number(issues[0].fix_change_id)).toBe(Number(changeId));
    expect(issues[0].status).toBe('open');
  });

  it('getLastOpenIssueId returns last open issue ID', () => {
    const proxy = freshDb();
    proxy.insertIssue({ title: 'first', status: 'open' });
    const secondId = proxy.insertIssue({ title: 'second', status: 'open' });
    expect(Number(proxy.getLastOpenIssueId())).toBe(Number(secondId));
  });

  it('getLastOpenIssueId returns null when no open issues', () => {
    const proxy = freshDb();
    expect(proxy.getLastOpenIssueId()).toBeNull();
  });
});

describe('db.js — hasRecentDetectionForFile (cooldown)', () => {
  it('returns false when no prior detection exists', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(false);
  });

  it('returns true when detection exists and fewer than N changes since then', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    proxy.insertDetection({
      session_id: 's1', file: 'app.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 1, message: 'x',
    });
    // 2 changes since detection — 2 < 3, still in cooldown
    proxy.insertChange({ file: 'app.js', session_id: 's1' });
    proxy.insertChange({ file: 'other.js', session_id: 's1' });
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(true);
  });

  it('returns false when >= N changes since last detection (cooldown expired)', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    proxy.insertDetection({
      session_id: 's1', file: 'app.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 1, message: 'x',
    });
    // Wait a tick to ensure different timestamps — use manual delay via busy loop
    const start = Date.now();
    while (Date.now() - start < 1100) { /* wait ~1s for SQLite CURRENT_TIMESTAMP second tick */ }
    // 3 changes since detection — 3 not < 3, cooldown off
    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: 'x.js', session_id: 's1' });
    }
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(false);
  }, 15000);

  it('distinguishes per-middleware — different middleware_id does not share cooldown', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    proxy.insertDetection({
      session_id: 's1', file: 'app.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 1, message: 'x',
    });
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(true);
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'cycle:embedding', 3)).toBe(false);
  });

  it('distinguishes per-file — different file does not share cooldown', () => {
    const proxy = freshDb();
    proxy.insertSession('s1');
    proxy.insertDetection({
      session_id: 's1', file: 'app.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 1, message: 'x',
    });
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(true);
    expect(proxy.hasRecentDetectionForFile('s1', 'other.js', 'cycle:file_match', 3)).toBe(false);
  });

  it('multi-tenant: project A detection does not leak into project B cooldown', () => {
    const db = loadDb();
    const projA = db.getDb('/proj/a');
    projA.insertSession('s1');
    projA.insertDetection({
      session_id: 's1', file: 'app.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 1, message: 'x',
    });
    const projB = db.getDb('/proj/b');
    projB.insertSession('s1');
    expect(projB.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(false);
    expect(projA.hasRecentDetectionForFile('s1', 'app.js', 'cycle:file_match', 3)).toBe(true);
  });

  it('returns false for invalid arguments (graceful)', () => {
    const proxy = freshDb();
    expect(proxy.hasRecentDetectionForFile(null, 'app.js', 'mw', 3)).toBe(false);
    expect(proxy.hasRecentDetectionForFile('s1', null, 'mw', 3)).toBe(false);
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', null, 3)).toBe(false);
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'mw', 0)).toBe(false);
    expect(proxy.hasRecentDetectionForFile('s1', 'app.js', 'mw', -1)).toBe(false);
  });
});

describe('insertChange — timestamp normalized at the DB layer', () => {
  it('normalizes an ISO-8601 timestamp to sqlite datetime format', () => {
    const proxy = freshDb();
    const id = proxy.insertChange({ file: 'a.js', session_id: 's1', action: 'Edit', timestamp: '2026-07-16T22:08:51.744Z' });
    const row = proxy.getChanges().find(r => r.id === id);
    expect(row.timestamp).toBe('2026-07-16 22:08:51');
  });

  it('falls back to CURRENT_TIMESTAMP when the timestamp is unparseable', () => {
    const proxy = freshDb();
    const id = proxy.insertChange({ file: 'a.js', session_id: 's1', action: 'Edit', timestamp: 'not-a-date' });
    const row = proxy.getChanges().find(r => r.id === id);
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('FK-safe cleanup', () => {
  it('deleteByProjectPath survives circular changes⇄issues FKs and wipes notes/note_events', () => {
    const proxy = freshDb('/proj/fk-a');
    proxy.insertSession('s1');
    const chId = proxy.insertChange({ file: 'a.js', session_id: 's1', action: 'Edit', description: 'x' });
    proxy.insertIssue({ title: 'bug', first_seen: '2026-01-01', status: 'open', fix_change_id: chId });
    const noteInfo = proxy.insertNote({
      file: 'a.js', node_id: 'core/fk', source: 'heuristic', confidence_level: 1, note_text: 'remember',
    });
    const noteId = typeof noteInfo === 'object' ? noteInfo.lastInsertRowid : noteInfo;
    proxy.insertNoteEvent({ note_id: noteId, session_id: 's1', event_type: 'surfaced' });

    expect(() => proxy.deleteByProjectPath('/proj/fk-a')).not.toThrow();
    expect(proxy.getChangeCount()).toBe(0);
    expect(proxy.getHeadNoteByNode('core/fk')).toBeUndefined();
    expect(proxy.getNoteComplianceStats().total).toBe(0);
  });

  it('runFifo can evict an oldest change that an issue references as its fix', () => {
    const proxy = freshDb('/proj/fk-b');
    proxy.insertSession('s1');
    const oldId = proxy.insertChange({ file: 'a.js', session_id: 's1', action: 'Edit', description: 'old', timestamp: '2026-01-01T00:00:00Z' });
    proxy.insertChange({ file: 'b.js', session_id: 's1', action: 'Edit', description: 'n1', timestamp: '2026-01-02T00:00:00Z' });
    proxy.insertChange({ file: 'c.js', session_id: 's1', action: 'Edit', description: 'n2', timestamp: '2026-01-03T00:00:00Z' });
    proxy.insertIssue({ title: 'bug', first_seen: '2026-01-01', status: 'open', fix_change_id: oldId });

    expect(() => proxy.runFifo(2)).not.toThrow();
    expect(proxy.getChangeCount()).toBe(2);
  });
});
