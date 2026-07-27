import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
function loadWorker() {
  return require('../../src/workers/seed-note-worker');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-sw-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-proj-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { loadDb().closeDb(); } catch { /* ignore */ }
  for (const d of [tmpDir, projectDir]) {
    if (d && fs.existsSync(d)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

describe('runWorker (seed drain)', () => {
  it('drains a pending job into a seed_purpose head note', async () => {
    const { getDb } = loadDb();
    const { runWorker } = loadWorker();
    getDb(projectDir).enqueueSeedNote({ change_id: 7, node_id: 'ui/theme', file: 'src/theme.js', code: 'x', session_id: 's1' });

    const created = await runWorker(projectDir, { generate: async () => 'Manages the theme state.' });

    const db = getDb(projectDir); // worker closed the shared singleton — reopen
    expect(created).toBe(1);
    const head = db.getHeadNoteByNode('ui/theme');
    expect(head.source).toBe('seed_purpose');
    expect(head.note_text).toBe('Manages the theme state.');
    expect(head.confidence_level).toBe(1);
    expect(head.source_file).toBe('src/theme.js');
    expect(db.getPendingSeedNotes()).toHaveLength(0);
  });

  it('skips a node that already has a head note without calling the generator', async () => {
    const { getDb } = loadDb();
    const { runWorker } = loadWorker();
    const seed = getDb(projectDir);
    seed.insertNote({ node_id: 'ui/theme', source: 'yol2_claude', note_text: 'real note', file: 'ui/theme', confidence_level: 3 });
    seed.enqueueSeedNote({ node_id: 'ui/theme', file: 'f.js', code: 'x' });
    const gen = vi.fn(async () => 'should not run');

    const created = await runWorker(projectDir, { generate: gen });

    const db = getDb(projectDir);
    expect(created).toBe(0);
    expect(gen).not.toHaveBeenCalled();
    expect(db.getPendingSeedNotes()).toHaveLength(0); // stale job cleared
    expect(db.getHeadNoteByNode('ui/theme').note_text).toBe('real note'); // untouched
  });

  it('writes no seed when the enqueued code is empty (real generatePurpose null-contract)', async () => {
    const { getDb } = loadDb();
    const { runWorker } = loadWorker();
    getDb(projectDir).enqueueSeedNote({ node_id: 'a/b', file: 'f.js', code: null });
    // Faithful seam: the real default calls generatePurpose({file, code}), which returns
    // null on falsy/non-string code (llm-note.js !code guard). Mirror that contract here.
    const generate = async (file, code) => (code && typeof code === 'string' ? 'Purpose.' : null);

    const created = await runWorker(projectDir, { generate });

    const db = getDb(projectDir);
    expect(created).toBe(0);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
    expect(db.getHeadNoteByNode('a/b')).toBeFalsy();
  });

  it('exits without draining when another worker holds a live claim', async () => {
    const { getDb } = loadDb();
    const { runWorker } = loadWorker();
    const seed = getDb(projectDir);
    seed.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    seed.claimSeedNotes(999999); // another (live) worker owns the job
    const gen = vi.fn(async () => 'should not run');

    const created = await runWorker(projectDir, { generate: gen });

    const db = getDb(projectDir);
    expect(created).toBe(0);
    expect(gen).not.toHaveBeenCalled();
    expect(db.getPendingSeedNotes()).toHaveLength(1); // untouched, still the other worker's
  });

  it('skips model work and clears jobs when disk space is insufficient', async () => {
    const { getDb } = loadDb();
    const { runWorker } = loadWorker();
    getDb(projectDir).enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    const gen = vi.fn(async () => 'Purpose.');

    const created = await runWorker(projectDir, { generate: gen, hasEnoughDisk: () => false });

    const db = getDb(projectDir);
    expect(created).toBe(0);
    expect(gen).not.toHaveBeenCalled(); // never loaded the model
    expect(db.getPendingSeedNotes()).toHaveLength(0); // claimed jobs cleared, no half-download
  });

  it('clears the job (no poison loop) when the generator yields null', async () => {
    const { getDb } = loadDb();
    const { runWorker } = loadWorker();
    getDb(projectDir).enqueueSeedNote({ node_id: 'a/b', file: 'f.js', code: 'x' });

    const created = await runWorker(projectDir, { generate: async () => null });

    const db = getDb(projectDir);
    expect(created).toBe(0);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
    expect(db.getHeadNoteByNode('a/b')).toBeFalsy();
  });
});
