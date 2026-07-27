import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir, projectDir, savedDisabled;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}
function loadSpawn() {
  return require('../../src/engine/spawn-worker');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-spawn-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-proj-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  savedDisabled = process.env.DEVGUARD_LLM_DISABLED;
  delete process.env.DEVGUARD_LLM_DISABLED;
});
afterEach(() => {
  try { loadDb().closeDb(); } catch { /* ignore */ }
  if (savedDisabled === undefined) delete process.env.DEVGUARD_LLM_DISABLED;
  else process.env.DEVGUARD_LLM_DISABLED = savedDisabled;
  for (const d of [tmpDir, projectDir]) {
    if (d && fs.existsSync(d)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

describe('spawnSeedNoteWorker', () => {
  it('spawns a detached worker and returns its pid without throwing', () => {
    const { spawnSeedNoteWorker } = loadSpawn();
    const pid = spawnSeedNoteWorker(projectDir);
    expect(pid === null || (Number.isInteger(pid) && pid > 0)).toBe(true);
  });
});

describe('maybeSpawnSeedWorker', () => {
  it('spawns when enabled and claimable jobs exist', () => {
    const { getDb } = loadDb();
    const { maybeSpawnSeedWorker } = loadSpawn();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    const spy = vi.fn(() => 12345);
    const r = maybeSpawnSeedWorker(db, { seed_note_enabled: true }, projectDir, { spawn: spy });
    expect(spy).toHaveBeenCalledWith(projectDir);
    expect(r).toBe(12345);
  });

  it('does not spawn when seed_note_enabled is false', () => {
    const { getDb } = loadDb();
    const { maybeSpawnSeedWorker } = loadSpawn();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    const spy = vi.fn(() => 1);
    maybeSpawnSeedWorker(db, { seed_note_enabled: false }, projectDir, { spawn: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not spawn when DEVGUARD_LLM_DISABLED=1', () => {
    process.env.DEVGUARD_LLM_DISABLED = '1';
    const { getDb } = loadDb();
    const { maybeSpawnSeedWorker } = loadSpawn();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    const spy = vi.fn(() => 1);
    maybeSpawnSeedWorker(db, { seed_note_enabled: true }, projectDir, { spawn: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not spawn when there are no claimable jobs', () => {
    const { getDb } = loadDb();
    const { maybeSpawnSeedWorker } = loadSpawn();
    const db = getDb(projectDir);
    const spy = vi.fn(() => 1);
    maybeSpawnSeedWorker(db, { seed_note_enabled: true }, projectDir, { spawn: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws when the spawn helper throws', () => {
    const { getDb } = loadDb();
    const { maybeSpawnSeedWorker } = loadSpawn();
    const db = getDb(projectDir);
    db.enqueueSeedNote({ node_id: 'a/b', file: 'f', code: 'x' });
    const spy = vi.fn(() => { throw new Error('spawn boom'); });
    expect(() => maybeSpawnSeedWorker(db, { seed_note_enabled: true }, projectDir, { spawn: spy })).not.toThrow();
  });
});
