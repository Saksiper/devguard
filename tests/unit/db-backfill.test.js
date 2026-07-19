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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-db-backfill-test-'));
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

describe('db.js — V14 migration (backfill provenance + cursor)', () => {
  it('is idempotent: row + new columns survive close/reopen (re-run migrations)', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    const id = proxy.insertChange({ file: 'a.js', description: 'pre-close' });
    expect(id).toBeGreaterThan(0);
    db.closeDb();

    // Re-open: runMigrations replays; V14 ALTER columns already exist, indexes
    // and table use IF NOT EXISTS, and the version is recorded so it is skipped.
    db.openDb();
    const proxy2 = db.getDb('/test/project');
    const rows = proxy2.getChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('pre-close');
    // New columns exist and default to null for legacy-style inserts.
    expect(rows[0]).toHaveProperty('tool_use_id', null);
    expect(rows[0]).toHaveProperty('source', null);
  });

  it('backfill_cursor table exists after migration', () => {
    const db = loadDb();
    const raw = db.openDb();
    const t = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='backfill_cursor'"
    ).get();
    expect(t).toBeTruthy();
  });
});

describe('db.js — insertChange provenance fields (V14)', () => {
  it('stores tool_use_id, source and a historical timestamp verbatim', () => {
    const proxy = freshDb();
    const historical = '2024-01-15 08:30:00';
    proxy.insertChange({
      file: 'src/x.js',
      description: 'replayed from transcript',
      tool_use_id: 'toolu_01HISTORICAL',
      source: 'backfill',
      timestamp: historical,
    });
    const row = proxy.getChanges()[0];
    expect(row.tool_use_id).toBe('toolu_01HISTORICAL');
    expect(row.source).toBe('backfill');
    // Historical timestamp preserved (NOT replaced with CURRENT_TIMESTAMP).
    expect(row.timestamp).toBe(historical);
  });

  it('without new fields: tool_use_id/source null, timestamp ~ now (live behavior)', () => {
    const proxy = freshDb();
    const before = Date.now();
    proxy.insertChange({ file: 'live.js', description: 'live edit' });
    const row = proxy.getChanges()[0];
    expect(row.tool_use_id).toBeNull();
    expect(row.source).toBeNull();
    // CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS'. Parse as UTC and confirm
    // it is within a small window of now (not a 2024 historical value).
    const ts = Date.parse(row.timestamp.replace(' ', 'T') + 'Z');
    expect(ts).toBeGreaterThanOrEqual(before - 5000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('sanitizes source before storing (secret redacted on readback)', () => {
    const proxy = freshDb();
    const skKey = 'sk-' + 'a'.repeat(24);
    proxy.insertChange({
      file: 'a.js',
      description: 'd',
      source: `backfill ${skKey}`,
    });
    const row = proxy.getChanges()[0];
    expect(row.source).not.toContain(skKey);
    expect(row.source).toContain('[REDACTED_API_KEY]');
  });
});

describe('db.js — partial unique index on (project_path, tool_use_id)', () => {
  it('duplicate (project_path, tool_use_id) second insert throws', () => {
    const proxy = freshDb();
    proxy.insertChange({ file: 'a.js', description: 'first', tool_use_id: 'toolu_DUP' });
    expect(() =>
      proxy.insertChange({ file: 'a.js', description: 'second', tool_use_id: 'toolu_DUP' })
    ).toThrow();
  });

  it('same tool_use_id in a different project does NOT conflict (multi-tenant)', () => {
    const db = loadDb();
    const projA = db.getDb('/proj/a');
    const projB = db.getDb('/proj/b');
    const idA = projA.insertChange({ file: 'a.js', description: 'A', tool_use_id: 'toolu_SHARED' });
    const idB = projB.insertChange({ file: 'b.js', description: 'B', tool_use_id: 'toolu_SHARED' });
    expect(idA).toBeGreaterThan(0);
    expect(idB).toBeGreaterThan(0);
    expect(projA.getChanges()).toHaveLength(1);
    expect(projB.getChanges()).toHaveLength(1);
  });

  it('null tool_use_id rows never conflict (partial index excludes NULL)', () => {
    const proxy = freshDb();
    // Many live-style inserts, all with null tool_use_id, all succeed.
    for (let i = 0; i < 5; i++) {
      const id = proxy.insertChange({ file: `f${i}.js`, description: `d${i}` });
      expect(id).toBeGreaterThan(0);
    }
    expect(proxy.getChanges()).toHaveLength(5);
    expect(proxy.getChanges().every(r => r.tool_use_id === null)).toBe(true);
  });
});

describe('db.js — backfill cursor get/set', () => {
  it('returns 0 when no cursor exists', () => {
    const proxy = freshDb();
    expect(proxy.getBackfillCursor('/path/to/transcript.jsonl')).toBe(0);
  });

  it('roundtrips a set value', () => {
    const proxy = freshDb();
    proxy.setBackfillCursor('/path/to/transcript.jsonl', 4096);
    expect(proxy.getBackfillCursor('/path/to/transcript.jsonl')).toBe(4096);
  });

  it('upsert overwrites last_size for the same transcript', () => {
    const proxy = freshDb();
    proxy.setBackfillCursor('/t.jsonl', 100);
    proxy.setBackfillCursor('/t.jsonl', 250);
    expect(proxy.getBackfillCursor('/t.jsonl')).toBe(250);
    // Distinct transcript keeps its own cursor.
    proxy.setBackfillCursor('/other.jsonl', 7);
    expect(proxy.getBackfillCursor('/t.jsonl')).toBe(250);
    expect(proxy.getBackfillCursor('/other.jsonl')).toBe(7);
  });
});
