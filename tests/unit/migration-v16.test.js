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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-mig16-'));
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

describe('MIGRATION_V16 — notes.source_file + notes.code_fingerprint', () => {
  it('applies clean on a fresh DB: notes gains source_file + code_fingerprint', () => {
    const db = loadDb();
    const raw = db.openDb();
    const cols = columns(raw, 'notes');
    expect(cols).toContain('source_file');
    expect(cols).toContain('code_fingerprint');
    const applied = raw.prepare('SELECT version FROM _migrations').all().map((r) => r.version);
    expect(applied).toContain(16);
  });

  it('insertNote round-trips source_file + code_fingerprint', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    const id = proxy.insertNote({
      file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude',
      confidence_level: 3, note_text: 'made filtering case-insensitive',
      source_file: '/abs/src/filter.js', code_fingerprint: 'a'.repeat(64),
    });
    expect(id).toBeGreaterThan(0);
    const head = proxy.getHeadNoteByNode('ui_ux/filter');
    expect(head.source_file).toBe('/abs/src/filter.js');
    expect(head.code_fingerprint).toBe('a'.repeat(64));
  });

  it('stores NULL for both when omitted (backward compatible)', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    proxy.insertNote({
      file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude',
      confidence_level: 3, note_text: 'no fingerprint',
    });
    const head = proxy.getHeadNoteByNode('ui_ux/filter');
    expect(head.source_file).toBeNull();
    expect(head.code_fingerprint).toBeNull();
  });

  it('is idempotent — re-opening the same DB does not re-apply V16', () => {
    const db = loadDb();
    db.openDb();
    db.closeDb();
    const db2 = loadDb();
    const raw2 = db2.openDb();
    const applied = raw2.prepare('SELECT version FROM _migrations WHERE version = 16').all();
    expect(applied).toHaveLength(1);
  });
});
