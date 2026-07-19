import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { assignFeature } = require('../../src/engine/feature-classifier');
const { DEFAULTS } = require('../../src/engine/config');

const THRESHOLD = DEFAULTS.feature_cluster_threshold; // calibrated default (0.28)

// Precomputed fixture — real MiniLM 384-dim embeddings. Tests load JSON ONLY; the
// transformer is never loaded in CI. Regenerate with tools/gen-feature-fixture.js.
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/feature-embeddings.json'), 'utf8'),
);
const bufOf = (s) => Buffer.from(new Float32Array(s.embedding).buffer);

function makeNormalizedBuffer(arr) {
  const f32 = new Float32Array(arr);
  let norm = 0;
  for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
  return Buffer.from(f32.buffer);
}

function unitNorm(buf) {
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  return Math.sqrt(n);
}

let tmpDir;
function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-feat-'));
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

function freshProxy() {
  const db = loadDb();
  return db.getDb('/feat/project');
}

// Process the whole fixture through assignFeature on a fresh DB, in fixture order.
function clusterFixture(proxy, threshold = THRESHOLD) {
  return fixture.samples.map((s) => {
    const res = assignFeature({
      db: proxy, projectPath: '/feat/project', filePath: s.file,
      description: s.description, diffText: null, embedding: bufOf(s), threshold,
    });
    return { ...s, node_id: res.node_id, continent_got: res.continent, country: res.country };
  });
}

describe('assignFeature — country clustering with hand-crafted UNIT vectors', () => {
  const v1 = makeNormalizedBuffer([1, 0, 0, 0]);
  const v1close = makeNormalizedBuffer([0.99, 0.14, 0, 0]); // cos ~0.99 vs v1
  const vOrtho = makeNormalizedBuffer([0, 0, 0, 1]); // cos 0 vs v1

  it('same-node collapse: a near-identical embedding joins the existing country', () => {
    const proxy = freshProxy();
    const r1 = assignFeature({ db: proxy, filePath: 'alpha.js', description: 'workflow alpha', embedding: v1, threshold: 0.5 });
    const r2 = assignFeature({ db: proxy, filePath: 'beta.js', description: 'workflow beta', embedding: v1close, threshold: 0.5 });
    expect(r1.continent).toBe('logic');
    expect(r2.node_id).toBe(r1.node_id); // collapsed into one country
  });

  it('member_count increments and centroid is re-normalized to unit length on join', () => {
    const proxy = freshProxy();
    const r1 = assignFeature({ db: proxy, filePath: 'alpha.js', description: 'workflow alpha', embedding: v1, threshold: 0.5 });
    assignFeature({ db: proxy, filePath: 'beta.js', description: 'workflow beta', embedding: v1close, threshold: 0.5 });
    const f = proxy.getFeature(r1.node_id);
    expect(f.member_count).toBe(2);
    expect(unitNorm(f.centroid_embedding)).toBeCloseTo(1.0, 5);
  });

  it('below-threshold embedding seeds a NEW country under the same continent', () => {
    const proxy = freshProxy();
    const r1 = assignFeature({ db: proxy, filePath: 'alpha.js', description: 'workflow alpha', embedding: v1, threshold: 0.5 });
    const r3 = assignFeature({ db: proxy, filePath: 'gamma.js', description: 'workflow gamma', embedding: vOrtho, threshold: 0.5 });
    expect(r3.node_id).not.toBe(r1.node_id);
    expect(r3.continent).toBe('logic');
    expect(proxy.getFeaturesByContinent('logic').length).toBe(2);
  });

  it('numeric-suffix dedupe: a colliding seed name gets -2 appended', () => {
    const proxy = freshProxy();
    // Two orthogonal embeddings whose files seed the same country name ("thing").
    const r1 = assignFeature({ db: proxy, filePath: 'thing.js', description: 'do work', embedding: v1, threshold: 0.9 });
    const r2 = assignFeature({ db: proxy, filePath: 'thing.js', description: 'do work', embedding: vOrtho, threshold: 0.9 });
    expect(r1.node_id).toBe('logic/thing');
    expect(r2.node_id).toBe('logic/thing-2');
  });
});

describe('F1 DEGRADED (unit): node_id is written even with NO embedding', () => {
  it('embedding absent -> node_id non-null (continent/seed), centroid stays NULL', () => {
    const proxy = freshProxy();
    const res = assignFeature({
      db: proxy, filePath: 'src/auth.js', description: 'add JWT login', diffText: null, embedding: null,
    });
    expect(res.node_id).not.toBeNull();
    expect(res.node_id.startsWith('security/')).toBe(true);
    const f = proxy.getFeature(res.node_id);
    expect(f).not.toBeNull();
    expect(f.centroid_embedding).toBeNull(); // degraded: no centroid
    expect(f.member_count).toBe(1);
  });

  it('a second degraded change on the same feature only moves member_count', () => {
    const proxy = freshProxy();
    const a = assignFeature({ db: proxy, filePath: 'src/auth.js', description: 'add login', embedding: null });
    const b = assignFeature({ db: proxy, filePath: 'src/auth.js', description: 'add login', embedding: null });
    expect(b.node_id).toBe(a.node_id);
    expect(proxy.getFeature(a.node_id).member_count).toBe(2);
  });

  it('degraded-then-embedded on the same seed HEALS the orphan into ONE node_id (no -2 fork)', () => {
    const proxy = freshProxy();
    const v1 = makeNormalizedBuffer([1, 0, 0, 0]);
    const v1close = makeNormalizedBuffer([0.99, 0.14, 0, 0]);
    // Edit #1: MiniLM still downloading -> embedding null (degraded placeholder).
    const r1 = assignFeature({ db: proxy, filePath: 'src/auth.js', description: 'add JWT login flow', embedding: null });
    expect(r1.node_id).toBe('security/auth');
    expect(proxy.getFeature(r1.node_id).centroid_embedding).toBeNull();
    // Edits #2 & #3: model ready -> must ADOPT the orphan, not fork to security/auth-2.
    const r2 = assignFeature({ db: proxy, filePath: 'src/auth.js', description: 'add JWT login flow', embedding: v1, threshold: 0.5 });
    const r3 = assignFeature({ db: proxy, filePath: 'src/auth.js', description: 'add JWT login flow', embedding: v1close, threshold: 0.5 });
    expect(r2.node_id).toBe(r1.node_id);
    expect(r3.node_id).toBe(r1.node_id);
    // Exactly ONE country under security; centroid now set; member_count counts all 3.
    expect(proxy.getFeaturesByContinent('security')).toHaveLength(1);
    const f = proxy.getFeature(r1.node_id);
    expect(f.centroid_embedding).not.toBeNull();
    expect(f.member_count).toBe(3);
  });
});

describe('F2 CROSS-FILE COHESION (the grain gate)', () => {
  it('3 differently-named files of ONE feature collapse to <= 2 countries', () => {
    const proxy = freshProxy();
    const all = clusterFixture(proxy);
    const trio = all.filter((s) => ['auth.js', 'login.js', 'token.js'].includes(s.file));
    expect(trio).toHaveLength(3);
    const countries = new Set(trio.map((s) => s.node_id));
    expect(countries.size).toBeLessThanOrEqual(2);
  });
});

describe('Wording-robustness eval', () => {
  it('6 differently-worded descriptions of one feature -> >= 5 collapse to one node_id', () => {
    const proxy = freshProxy();
    const all = clusterFixture(proxy);
    const ua = all.filter((s) => s.feature === 'user-auth');
    expect(ua).toHaveLength(6);
    const counts = {};
    for (const s of ua) counts[s.node_id] = (counts[s.node_id] || 0) + 1;
    expect(Math.max(...Object.values(counts))).toBeGreaterThanOrEqual(5);
  });
});

describe('Separation: distinct features (same continent) must NOT collapse', () => {
  it('no node contains changes from two different features (0 false merges)', () => {
    const proxy = freshProxy();
    const all = clusterFixture(proxy);
    const nodeFeatures = {};
    for (const s of all) (nodeFeatures[s.node_id] = nodeFeatures[s.node_id] || new Set()).add(s.feature);
    const contaminated = Object.entries(nodeFeatures)
      .filter(([, set]) => set.size > 1)
      .map(([n, set]) => `${n}{${[...set].join(',')}}`);
    expect(contaminated).toEqual([]);
  });

  it('within ui_ux, the filter feature and the modal feature stay distinct', () => {
    const proxy = freshProxy();
    const all = clusterFixture(proxy);
    const filterNodes = new Set(all.filter((s) => s.feature === 'product-filter').map((s) => s.node_id));
    const modalNodes = new Set(all.filter((s) => s.feature === 'modal-dialog').map((s) => s.node_id));
    // no shared node between the two features
    for (const n of filterNodes) expect(modalNodes.has(n)).toBe(false);
  });
});

describe('30-sample clustering eval (fresh temp DB, precomputed fixture)', () => {
  it('>= 80% correct continent AND country (clustered with feature, uncontaminated)', () => {
    const proxy = freshProxy();
    const all = clusterFixture(proxy);
    expect(all.length).toBeGreaterThanOrEqual(30);

    // modal node per feature + exclusivity (a node claimed by >1 feature = merge)
    const byFeature = {};
    for (const s of all) {
      byFeature[s.feature] = byFeature[s.feature] || {};
      byFeature[s.feature][s.node_id] = (byFeature[s.feature][s.node_id] || 0) + 1;
    }
    const modal = {};
    for (const f of Object.keys(byFeature)) {
      let best = null, bc = -1;
      for (const [n, c] of Object.entries(byFeature[f])) if (c > bc) { bc = c; best = n; }
      modal[f] = best;
    }
    const owners = {};
    for (const f of Object.keys(modal)) (owners[modal[f]] = owners[modal[f]] || []).push(f);

    let contOk = 0;
    let correct = 0;
    for (const s of all) {
      if (s.continent_got === s.continent) contOk++;
      const ok = s.continent_got === s.continent
        && s.node_id === modal[s.feature]
        && owners[modal[s.feature]].length === 1;
      if (ok) correct++;
    }
    const contAcc = contOk / all.length;
    const acc = correct / all.length;
    // Report actual numbers for the calibration record.
    console.log(`[30-sample @thr=${THRESHOLD}] continent=${(contAcc * 100).toFixed(0)}% continent+country=${(acc * 100).toFixed(0)}% (${correct}/${all.length})`);

    expect(contAcc).toBeGreaterThanOrEqual(0.80);
    expect(acc).toBeGreaterThanOrEqual(0.80);
  });
});
