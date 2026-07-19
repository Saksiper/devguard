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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-mig15-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL lock */ }
  }
});

function columns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function tableExists(raw, name) {
  return !!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

describe('MIGRATION_V15 — features table + changes.node_id', () => {
  it('applies clean on a FRESH DB (all 15 migrations)', () => {
    const db = loadDb();
    const raw = db.openDb();
    expect(tableExists(raw, 'features')).toBe(true);
    expect(columns(raw, 'changes')).toContain('node_id');
    const applied = raw.prepare('SELECT version FROM _migrations').all().map((r) => r.version);
    expect(applied).toContain(15);
    // feature schema shape
    const fcols = columns(raw, 'features');
    for (const c of ['project_path', 'continent', 'country', 'node_id', 'centroid_embedding', 'member_count', 'updated_at']) {
      expect(fcols).toContain(c);
    }
  });

  it('re-opening the DB does NOT re-apply V15 (no duplicate-column error)', () => {
    const db = loadDb();
    db.openDb();
    db.closeDb();
    // Second open runs runMigrations again; V15 must be skipped, not replayed.
    expect(() => {
      const db2 = loadDb();
      const raw = db2.openDb();
      expect(columns(raw, 'changes')).toContain('node_id');
    }).not.toThrow();
  });

  it('applies clean on a V14 DB (migrations 1..14 already applied)', () => {
    // Build a DB stuck at V14: _migrations rows 1..14 + a `changes` table WITHOUT
    // node_id, and a `notes` table (present since V13, so V16's ALTER has a target).
    // Requiring the module then runs V15+V16, which must ALTER in node_id and
    // CREATE features without a duplicate-column error.
    const Database = require('better-sqlite3');
    const dbFile = path.join(tmpDir, 'devguard.db');
    const seed = new Database(dbFile);
    seed.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE changes (id INTEGER PRIMARY KEY, project_path TEXT NOT NULL, file TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE notes (id INTEGER PRIMARY KEY, project_path TEXT NOT NULL);
    `);
    const ins = seed.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)');
    for (let v = 1; v <= 14; v++) ins.run(v, 'legacy_v' + v);
    expect(columns(seed, 'changes')).not.toContain('node_id');
    seed.close();

    const db = loadDb();
    let raw;
    expect(() => { raw = db.openDb(); }).not.toThrow();
    expect(columns(raw, 'changes')).toContain('node_id');
    expect(tableExists(raw, 'features')).toBe(true);
    const applied = raw.prepare('SELECT version FROM _migrations').all().map((r) => r.version);
    expect(applied).toContain(15);
  });
});
