import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const { resolveNodeIdByEmbedding } = require('../../src/engine/embedding-node-resolver');

// Unit-normalized Float32 Buffer (cosineSimilarity assumes unit vectors).
function vec(arr) {
  const f = new Float32Array(arr);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < f.length; i++) f[i] /= n;
  return Buffer.from(f.buffer);
}

// deps that NEVER load a real model — loadModel returns a truthy stub, encode maps
// the prompt to a fixed vector. The real cosineSimilarity is used (not overridden).
function fakeDeps(vectorForPrompt) {
  return {
    loadModel: async () => ({}),
    encode: async (t) => vectorForPrompt(t),
  };
}

const FEATURES = [
  { node_id: 'ui_ux/filter', continent: 'ui_ux', centroid_embedding: vec([1, 0, 0, 0]) },
  { node_id: 'security/auth', continent: 'security', centroid_embedding: vec([0, 1, 0, 0]) },
  { node_id: 'data/store', continent: 'data', centroid_embedding: vec([0, 0, 1, 0]) },
];
const fakeDb = { getAllFeatures: () => FEATURES };

describe('embedding-node-resolver (S2.B)', () => {
  it('global argmax: picks the feature whose centroid is nearest the prompt vector', async () => {
    const node = await resolveNodeIdByEmbedding(fakeDb, 'log in please', 0.5, fakeDeps(() => vec([0.1, 1, 0, 0])));
    expect(node).toBe('security/auth');
  });

  it('above threshold → returns node_id', async () => {
    const node = await resolveNodeIdByEmbedding(fakeDb, 'x', 0.9, fakeDeps(() => vec([1, 0.05, 0, 0])));
    expect(node).toBe('ui_ux/filter');
  });

  it('below threshold → null', async () => {
    // best cosine here is 0.707 (against [1,0,0,0]); threshold 0.99 rejects it.
    const node = await resolveNodeIdByEmbedding(fakeDb, 'x', 0.99, fakeDeps(() => vec([1, 1, 0, 0])));
    expect(node).toBeNull();
  });

  it('cross-continent scan: argmax spans continents, not just the first', async () => {
    const node = await resolveNodeIdByEmbedding(fakeDb, 'x', 0.5, fakeDeps(() => vec([0, 0, 1, 0.1])));
    expect(node).toBe('data/store');
  });

  it('tie: deterministic — first feature in getAllFeatures order wins', async () => {
    const tied = [
      { node_id: 'ui_ux/a', centroid_embedding: vec([1, 0, 0, 0]) },
      { node_id: 'ui_ux/b', centroid_embedding: vec([1, 0, 0, 0]) },
    ];
    const node = await resolveNodeIdByEmbedding({ getAllFeatures: () => tied }, 'x', 0.5, fakeDeps(() => vec([1, 0, 0, 0])));
    expect(node).toBe('ui_ux/a');
  });

  it('empty prompt → null without loading the model', async () => {
    let loaded = false;
    const node = await resolveNodeIdByEmbedding(fakeDb, '', 0.5, {
      loadModel: async () => { loaded = true; return {}; },
      encode: async () => vec([1, 0, 0, 0]),
    });
    expect(node).toBeNull();
    expect(loaded).toBe(false);
  });

  it('model unavailable (loadModel null) → null', async () => {
    const node = await resolveNodeIdByEmbedding(fakeDb, 'x', 0.5, {
      loadModel: async () => null,
      encode: async () => vec([1, 0, 0, 0]),
    });
    expect(node).toBeNull();
  });

  it('encode failure (null) → null', async () => {
    const node = await resolveNodeIdByEmbedding(fakeDb, 'x', 0.5, {
      loadModel: async () => ({}),
      encode: async () => null,
    });
    expect(node).toBeNull();
  });

  it('features with a null centroid are skipped', async () => {
    const partial = [
      { node_id: 'ui_ux/filter', centroid_embedding: null },
      { node_id: 'security/auth', centroid_embedding: vec([0, 1, 0, 0]) },
    ];
    const node = await resolveNodeIdByEmbedding({ getAllFeatures: () => partial }, 'x', 0.5, fakeDeps(() => vec([0.2, 1, 0, 0])));
    expect(node).toBe('security/auth');
  });

  it('no features → null', async () => {
    const node = await resolveNodeIdByEmbedding({ getAllFeatures: () => [] }, 'x', 0.5, fakeDeps(() => vec([1, 0, 0, 0])));
    expect(node).toBeNull();
  });
});

describe('embedding-node-resolver — surfaced precondition against a REAL project-scoped db', () => {
  let tmpDir;
  let projectDir;

  function loadDb() {
    delete require.cache[require.resolve('../../src/engine/db')];
    delete require.cache[require.resolve('../../src/engine/sanitize')];
    delete require.cache[require.resolve('../../src/engine/debug-log')];
    return require('../../src/engine/db');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-enr-test-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-enr-project-'));
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  });

  afterEach(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    for (const dir of [tmpDir, projectDir]) {
      if (dir && fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
      }
    }
  });

  it('resolved node exposes a head note only when one was seeded (surface fires vs stays silent)', async () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    proxy.upsertFeatureCentroid({ continent: 'ui_ux', country: 'filter', node_id: 'ui_ux/filter', embedding: vec([1, 0, 0, 0]) });
    proxy.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: vec([0, 1, 0, 0]) });
    proxy.insertNote({ file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude', confidence_level: 3, note_text: 'prior' });

    // getAllFeatures (real, project-scoped) spans continents; argmax picks filter.
    const withNote = await resolveNodeIdByEmbedding(proxy, 'x', 0.5, fakeDeps(() => vec([1, 0.05, 0, 0])));
    expect(withNote).toBe('ui_ux/filter');
    expect(proxy.getHeadNoteByNode(withNote)).toBeTruthy();

    // A resolved node with no seeded note → head is null → hook would emit no 'surfaced' event.
    const noNote = await resolveNodeIdByEmbedding(proxy, 'x', 0.5, fakeDeps(() => vec([0.05, 1, 0, 0])));
    expect(noNote).toBe('security/auth');
    expect(proxy.getHeadNoteByNode(noNote)).toBeFalsy();

    db.closeDb();
    delete require.cache[require.resolve('../../src/engine/db')];
  });
});
