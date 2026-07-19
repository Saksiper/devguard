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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-mig17-'));
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

describe('MIGRATION_V17 — normalize legacy ISO timestamps in changes', () => {
  it('normalizes pre-existing ISO rows on upgrade and leaves normalized rows untouched', () => {
    let db = loadDb();
    let raw = db.openDb();
    // Simulate a pre-V17 database: drop the migration record, then plant rows
    // exactly as the old backfill wrote them (raw ISO-8601 with T/Z).
    raw.prepare('DELETE FROM _migrations WHERE version = 17').run();
    const ins = raw.prepare(
      'INSERT INTO changes (project_path, session_id, file, action, timestamp) VALUES (?,?,?,?,?)');
    ins.run('/test/project', 's1', 'a.js', 'Edit', '2026-07-16T22:08:51.744Z');
    ins.run('/test/project', 's1', 'b.js', 'Edit', '2026-07-10 09:00:00');
    db.closeDb();

    db = loadDb();
    raw = db.openDb();
    const rows = raw.prepare('SELECT file, timestamp FROM changes ORDER BY id').all();
    expect(rows[0].timestamp).toBe('2026-07-16 22:08:51');
    expect(rows[1].timestamp).toBe('2026-07-10 09:00:00');
    const applied = raw.prepare('SELECT version FROM _migrations WHERE version = 17').all();
    expect(applied).toHaveLength(1);
  });
});
