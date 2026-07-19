import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

const {
  buildFeatureNodes,
  buildNeighborEdges,
  buildNoteChain,
  renderHtml,
} = require('../../tools/dg-spheremap');

// Unit-normalized Float32 buffer — cosineSimilarity() assumes inputs are already
// normalized (it is a plain dot product), so we normalize here to control cosines.
function normBuf(arr) {
  const f = new Float32Array(arr);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < f.length; i++) f[i] /= n;
  return Buffer.from(f.buffer);
}

const PROJ = '/sphere/project';
const OTHER = '/other/project';
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-sphere-'));
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

// Centroids: A and B near-identical (cosine ~0.98), C orthogonal to both.
const A = normBuf([0.98, 0.2, 0, 0, 0, 0, 0, 0]);
const B = normBuf([1.0, 0.0, 0, 0, 0, 0, 0, 0]);
const C = normBuf([0, 0, 0, 0, 0, 0, 0, 1]);

function seedProject(proxy, { withCentroids = true } = {}) {
  proxy.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: withCentroids ? A : null });
  proxy.upsertFeatureCentroid({ continent: 'security', country: 'login', node_id: 'security/login', embedding: withCentroids ? B : null });
  proxy.upsertFeatureCentroid({ continent: 'data', country: 'export', node_id: 'data/export', embedding: withCentroids ? C : null });

  // 3 edits on security/auth, 1 on security/login, 0 on data/export.
  for (let i = 0; i < 3; i++) {
    const id = proxy.insertChange({ file: 'src/auth.js', description: 'auth edit ' + i, session_id: 's1' });
    proxy.updateChangeNodeId(id, 'security/auth');
  }
  const lid = proxy.insertChange({ file: 'src/login.js', description: 'login edit', session_id: 's1' });
  proxy.updateChangeNodeId(lid, 'security/login');

  // A 3-layer superseded note chain on security/auth (n1 -> n2 -> n3=head).
  const n1 = proxy.insertNote({ file: 'src/auth.js', node_id: 'security/auth', source: 'test', confidence_level: 3, note_text: 'layer 1' });
  const n2 = proxy.insertNote({ file: 'src/auth.js', node_id: 'security/auth', source: 'test', confidence_level: 3, note_text: 'layer 2' });
  proxy.supersedePriorHead('security/auth', n2);
  const n3 = proxy.insertNote({ file: 'src/auth.js', node_id: 'security/auth', source: 'test', confidence_level: 3, note_text: 'layer 3' });
  proxy.supersedePriorHead('security/auth', n3);
  return { n1, n2, n3 };
}

describe('dg-spheremap — buildFeatureNodes', () => {
  it('emits one node per feature with continent grouping and tallies', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    seedProject(proxy);

    const nodes = buildFeatureNodes(proxy);
    expect(nodes).toHaveLength(3);

    const byId = Object.fromEntries(nodes.map((n) => [n.node_id, n]));
    expect(byId['security/auth'].continent).toBe('security');
    expect(byId['security/auth'].country).toBe('auth');
    expect(byId['security/auth'].editCount).toBe(3);
    expect(byId['security/auth'].noteCount).toBe(3);
    expect(byId['security/login'].editCount).toBe(1);
    expect(byId['data/export'].editCount).toBe(0);
    expect(byId['data/export'].noteCount).toBe(0);
    expect(byId['security/auth'].memberCount).toBe(1);
    expect(byId['security/auth'].lastActivity).toBeTruthy();
  });

  it('is project_path scoped — other project features are excluded', () => {
    const db = loadDb();
    seedProject(db.getDb(PROJ));
    const other = db.getDb(OTHER);
    other.upsertFeatureCentroid({ continent: 'infra', country: 'ci', node_id: 'infra/ci', embedding: A });

    const nodes = buildFeatureNodes(db.getDb(PROJ));
    expect(nodes.map((n) => n.node_id)).not.toContain('infra/ci');
    expect(nodes).toHaveLength(3);
  });

  it('returns empty array when no features exist', () => {
    const db = loadDb();
    expect(buildFeatureNodes(db.getDb(PROJ))).toEqual([]);
  });
});

describe('dg-spheremap — buildNeighborEdges', () => {
  function centroidRows(db) {
    const proxy = db.getDb(PROJ);
    seedProject(proxy);
    return proxy.getAllFeatures().map((f) => ({ node_id: f.node_id, centroid_embedding: f.centroid_embedding }));
  }

  it('links near-identical centroids above threshold, drops orthogonal, no self-edge', () => {
    const db = loadDb();
    const edges = buildNeighborEdges(centroidRows(db), 0.5, 50);
    expect(edges).toHaveLength(1);
    const [e] = edges;
    expect(new Set([e.source, e.target])).toEqual(new Set(['security/auth', 'security/login']));
    expect(e.weight).toBeGreaterThan(0.5);
    expect(edges.every((x) => x.source !== x.target)).toBe(true);
    // data/export (orthogonal) appears in no edge.
    expect(edges.some((x) => x.source === 'data/export' || x.target === 'data/export')).toBe(false);
  });

  it('caps at topN and sorts by weight descending', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    seedProject(proxy);
    // Add a duplicate of A so there are multiple above-threshold pairs.
    proxy.upsertFeatureCentroid({ continent: 'security', country: 'dup', node_id: 'security/dup', embedding: A });
    const rows = proxy.getAllFeatures().map((f) => ({ node_id: f.node_id, centroid_embedding: f.centroid_embedding }));

    const all = buildNeighborEdges(rows, 0.5, 50);
    expect(all.length).toBeGreaterThan(1);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].weight).toBeGreaterThanOrEqual(all[i].weight);
    }
    const capped = buildNeighborEdges(rows, 0.5, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].weight).toBe(all[0].weight);
  });

  it('is deterministic across repeated calls (stable tie order)', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    seedProject(proxy);
    proxy.upsertFeatureCentroid({ continent: 'security', country: 'dup', node_id: 'security/dup', embedding: A });
    const rows = proxy.getAllFeatures().map((f) => ({ node_id: f.node_id, centroid_embedding: f.centroid_embedding }));
    expect(buildNeighborEdges(rows, 0.5, 50)).toEqual(buildNeighborEdges(rows, 0.5, 50));
  });

  it('skips features with null centroid without crashing', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    seedProject(proxy, { withCentroids: false });
    const rows = proxy.getAllFeatures().map((f) => ({ node_id: f.node_id, centroid_embedding: f.centroid_embedding }));
    expect(buildNeighborEdges(rows, 0.5, 50)).toEqual([]);
  });
});

describe('dg-spheremap — buildNoteChain', () => {
  it('returns head first then superseded ancestors in order', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    const { n1, n2, n3 } = seedProject(proxy);

    const chain = buildNoteChain(proxy, 'security/auth');
    expect(chain.map((c) => c.noteId)).toEqual([n3, n2, n1]);
    expect(chain[0].isHead).toBe(true);
    expect(chain.slice(1).every((c) => c.isHead === false)).toBe(true);
    expect(chain[0].text).toBe('layer 3');
    expect(chain[2].text).toBe('layer 1');
  });

  it('returns empty for a node with no notes', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    seedProject(proxy);
    expect(buildNoteChain(proxy, 'data/export')).toEqual([]);
  });

  // Regression: getNotesByNode must not silently cap at the default LIMIT 50. A
  // feature with >50 layered notes must report the true count and the full chain.
  it('does not truncate a chain longer than the default note limit (>50)', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    proxy.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: A });
    const N = 55;
    for (let i = 0; i < N; i++) {
      const id = proxy.insertNote({ file: 'src/auth.js', node_id: 'security/auth', source: 'test', confidence_level: 3, note_text: 'layer ' + i });
      proxy.supersedePriorHead('security/auth', id);
    }

    const chain = buildNoteChain(proxy, 'security/auth');
    expect(chain).toHaveLength(N);
    // The oldest layers must survive (chain tail = layer 0).
    expect(chain[chain.length - 1].text).toBe('layer 0');
    expect(chain[0].text).toBe('layer ' + (N - 1));

    const nodes = buildFeatureNodes(proxy);
    const auth = nodes.find((n) => n.node_id === 'security/auth');
    expect(auth.noteCount).toBe(N);
  });

  // Regression: forked history (multiple prior heads collapsed onto one head via
  // supersedePriorHead) must not drop sibling layers — walk ALL predecessors.
  it('captures all predecessors when history forked (collapsed heads)', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    proxy.upsertFeatureCentroid({ continent: 'data', country: 'x', node_id: 'data/x', embedding: A });
    // Two independent heads (both superseded_by NULL).
    const hA = proxy.insertNote({ file: 'src/x.js', node_id: 'data/x', source: 'test', confidence_level: 3, note_text: 'branchA' });
    const hB = proxy.insertNote({ file: 'src/x.js', node_id: 'data/x', source: 'test', confidence_level: 3, note_text: 'branchB' });
    // New head collapses BOTH prior heads onto hC at once.
    const hC = proxy.insertNote({ file: 'src/x.js', node_id: 'data/x', source: 'test', confidence_level: 3, note_text: 'merged' });
    proxy.supersedePriorHead('data/x', hC);

    const chain = buildNoteChain(proxy, 'data/x');
    const ids = chain.map((c) => c.noteId);
    expect(ids).toContain(hC);
    expect(ids).toContain(hA);
    expect(ids).toContain(hB);
    expect(chain).toHaveLength(3);
    expect(chain[0].isHead).toBe(true);
    expect(chain.slice(1).every((c) => c.isHead === false)).toBe(true);
  });
});

describe('dg-spheremap — renderHtml (smoke)', () => {
  it('writes a self-contained file containing node_ids and no unescaped </script>', () => {
    const db = loadDb();
    const proxy = db.getDb(PROJ);
    seedProject(proxy);
    const nodes = buildFeatureNodes(proxy);
    const rows = proxy.getAllFeatures().map((f) => ({ node_id: f.node_id, centroid_embedding: f.centroid_embedding }));
    const edges = buildNeighborEdges(rows, 0.5, 50);
    const chainsByNode = { 'security/auth': buildNoteChain(proxy, 'security/auth') };

    const out = path.join(tmpDir, 'sphere.html');
    const html = renderHtml({ nodes, edges, chainsByNode, project: 'sphere-test' }, out);
    expect(fs.existsSync(out)).toBe(true);

    const written = fs.readFileSync(out, 'utf8');
    expect(written).toContain('security/auth');
    expect(written).toContain('data/export');
    // No raw </script> inside the embedded JSON data island.
    const dataIsland = written.slice(written.indexOf('const DATA ='));
    expect(dataIsland).not.toMatch(/[^\\]<\/script>\s*[,}]/);
    expect(html).toContain('<!doctype html>');
  });

  it('produces valid empty-ish HTML when there are no features', () => {
    const out = path.join(tmpDir, 'empty.html');
    const html = renderHtml({ nodes: [], edges: [], chainsByNode: {}, project: 'empty' }, out);
    expect(fs.existsSync(out)).toBe(true);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('ForceGraph3D');
  });
});
