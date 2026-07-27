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

describe('seed claim (single-flight)', () => {
  it('claims unclaimed rows, stamps worker_pid, and returns the count', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f1', code: 'x' });
    db.enqueueSeedNote({ node_id: 'c/d', file: 'f2', code: 'y' });
    expect(db.claimSeedNotes(100)).toBe(2);
    const mine = db.getClaimedSeedNotes(100);
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.worker_pid === 100)).toBe(true);
    closeDb();
  });

  it('a second immediate claim gets 0 rows (single-flight)', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    expect(db.claimSeedNotes(100)).toBe(1);
    expect(db.claimSeedNotes(200)).toBe(0);
    expect(db.getClaimedSeedNotes(200)).toHaveLength(0);
    closeDb();
  });

  it('reclaims stale claims when the stale window has passed', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    db.claimSeedNotes(100);
    // negative window => "now + N min" cutoff => every existing claim counts as stale
    expect(db.claimSeedNotes(200, -1)).toBe(1);
    expect(db.getClaimedSeedNotes(200)).toHaveLength(1);
    closeDb();
  });

  it('countClaimableSeedNotes counts unclaimed (and stale) rows', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    db.enqueueSeedNote({ node_id: 'c/d', file: 'g', code: 'y' });
    expect(db.countClaimableSeedNotes()).toBe(2);
    db.claimSeedNotes(100);
    expect(db.countClaimableSeedNotes()).toBe(0); // all freshly claimed
    expect(db.countClaimableSeedNotes(-1)).toBe(2); // negative window -> all stale/claimable
    closeDb();
  });

  it('hasLiveClaim detects another live worker but not itself or stale claims', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    db.claimSeedNotes(100);
    expect(db.hasLiveClaim(200)).toBe(true); // 100 holds a live claim
    expect(db.hasLiveClaim(100)).toBe(false); // excludes self
    expect(db.hasLiveClaim(200, -1)).toBe(false); // negative window -> claim not "live"
    closeDb();
  });
});
