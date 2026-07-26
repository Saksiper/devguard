import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
function loadPostEdit() {
  return require('../../src/hooks/post-edit');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-pes-'));
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

const JOB = { changeId: 1, node_id: 'security/auth', file: 'src/auth.js', code: 'const x = 1', sessionId: 's1' };

describe('maybeEnqueueSeedNote', () => {
  it('enqueues a seed job for a brand-new node when enabled', () => {
    const { getDb } = loadDb();
    const { maybeEnqueueSeedNote } = loadPostEdit();
    const db = getDb(projectDir);
    maybeEnqueueSeedNote(db, { seed_note_enabled: true }, JOB);
    const pending = db.getPendingSeedNotes();
    expect(pending).toHaveLength(1);
    expect(pending[0].node_id).toBe('security/auth');
    expect(pending[0].code).toBe('const x = 1');
  });

  it('does NOT enqueue when seed_note_enabled is false (kill-switch)', () => {
    const { getDb } = loadDb();
    const { maybeEnqueueSeedNote } = loadPostEdit();
    const db = getDb(projectDir);
    maybeEnqueueSeedNote(db, { seed_note_enabled: false }, JOB);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
  });

  it('does NOT enqueue when DEVGUARD_LLM_DISABLED=1', () => {
    process.env.DEVGUARD_LLM_DISABLED = '1';
    const { getDb } = loadDb();
    const { maybeEnqueueSeedNote } = loadPostEdit();
    const db = getDb(projectDir);
    maybeEnqueueSeedNote(db, { seed_note_enabled: true }, JOB);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
  });

  it('does NOT enqueue when the node already has a head note (idempotent)', () => {
    const { getDb } = loadDb();
    const { maybeEnqueueSeedNote } = loadPostEdit();
    const db = getDb(projectDir);
    db.insertNote({ node_id: 'security/auth', source: 'yol2_claude', note_text: 'existing', file: 'security/auth', confidence_level: 3 });
    maybeEnqueueSeedNote(db, { seed_note_enabled: true }, JOB);
    expect(db.getPendingSeedNotes()).toHaveLength(0);
  });
});
