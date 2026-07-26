import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir, projectDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-seedq-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-proj-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { loadDb().closeDb(); } catch { /* ignore */ }
  for (const d of [tmpDir, projectDir]) {
    if (d && fs.existsSync(d)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

describe('pending_seed_notes queue', () => {
  it('enqueues a seed job and reads it back with all fields', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({
      change_id: 5, node_id: 'security/auth', file: 'src/auth.js',
      code: 'export const x = 1', session_id: 's1',
    });
    const pending = db.getPendingSeedNotes();
    expect(pending).toHaveLength(1);
    expect(pending[0].node_id).toBe('security/auth');
    expect(pending[0].file).toBe('src/auth.js');
    expect(pending[0].code).toBe('export const x = 1');
    expect(pending[0].change_id).toBe(5);
    expect(pending[0].id).toBeGreaterThan(0);
    closeDb();
  });

  it('returns the new row id from enqueue so a worker can delete it', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id = db.enqueueSeedNote({ node_id: 'a/b', file: 'f.js', code: 'x' });
    expect(id).toBeGreaterThan(0);
    db.deleteSeedNote(id);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
    closeDb();
  });

  it('deleteByProjectPath clears that project pending jobs too', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f.js', code: 'x' });
    expect(db.getPendingSeedNotes()).toHaveLength(1);
    db.deleteByProjectPath(projectDir);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
    closeDb();
  });
});
