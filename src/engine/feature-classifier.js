'use strict';

// Semantic placement (S1). Every 'changes' row is assigned a node_id
// ("continent/country") at write-time — UNCONDITIONALLY, including when embeddings
// are disabled. The continent is a model-free heuristic (always runnable). When an
// embedding is available it refines the country via nearest-centroid clustering,
// reusing the embedding post-edit already computes.
//
// Pure module: the only IO is through the injected project-scoped `db` proxy. No
// model load happens here (that stays in post-edit / PostToolUse async only).

const { normalizeCountry } = require('./node-taxonomy');
const { cosineSimilarity } = require('./embedding');
const { DEFAULTS } = require('./config');

// Precedence-ordered keyword groups. Each continent owns a list of semantic labels;
// the FIRST label found (in list order) also seeds a cold-start country name (F2:
// reduce basename bias). Matching is anchored with \b so 'auth' fires on 'auth.js'
// and 'authenticate' but structural cases (extensions, dirs) are handled separately.
const CONTINENT_KEYWORDS = {
  // 'ci' is intentionally covered by the structural .github/ + .ya?ml checks rather
  // than a raw 'ci' token — a \bci prefix match would fire on circle/city/etc.
  infra: ['terraform', 'kubernetes', 'k8s', 'deploy'],
  security: ['auth', 'login', 'token', 'jwt', 'oauth', 'crypto', 'encrypt', 'decrypt', 'cipher', 'signature', 'password', 'permission'],
  data: ['sql', 'migration', 'schema', 'model', 'query', 'repository', 'dao'],
  ui_ux: ['component', 'render', 'button', 'modal', 'filter', 'style'],
  math: ['matrix', 'vector', 'geometry'],
};

function detectKeyword(hay, keywords) {
  for (const kw of keywords) {
    // \b + kw: prefix word-boundary — 'auth' matches 'auth.js'/'authenticate',
    // 'k8s' matches 'k8s'. Avoids matching mid-word noise like 'reauthored'.
    if (new RegExp('\\b' + kw).test(hay)) return kw;
  }
  return null;
}

// Returns { continent, keyword } where keyword is a semantic seed label (or null →
// fall back to basename). Ordered first-match precedence:
//   test -> docs -> infra -> security -> data -> ui_ux -> math -> logic(fallback)
function classifyContinentDetailed(filePath, text) {
  const fp = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  const base = fp.split('/').pop() || '';
  const hay = (fp + ' ' + String(text || '')).toLowerCase();

  // 1. test — structural checks FIRST so x.test.tsx -> test, NOT ui_ux (.tsx).
  if (/(^|\/)tests?\//.test(fp) || /\.test\./.test(base) || /\.spec\./.test(base) || /__tests__/.test(fp)) {
    return { continent: 'test', keyword: 'test' };
  }
  // 2. docs
  if (/\.(md|rst|txt)$/.test(base) || /(^|\/)docs?\//.test(fp)) {
    return { continent: 'docs', keyword: 'docs' };
  }
  // 3. infra — structural (Dockerfile, .ya?ml, .github/, package.json, terraform .tf)
  if (/dockerfile/.test(base) || /\.ya?ml$/.test(base) || /(^|\/)\.github\//.test(fp) ||
      base === 'package.json' || /\.tf$/.test(base)) {
    return { continent: 'infra', keyword: 'infra' };
  }
  {
    const kw = detectKeyword(hay, CONTINENT_KEYWORDS.infra);
    if (kw) return { continent: 'infra', keyword: kw };
  }
  // 4. security
  {
    const kw = detectKeyword(hay, CONTINENT_KEYWORDS.security);
    if (kw) return { continent: 'security', keyword: kw };
  }
  // 5. data — 'sql' keyword also fires on a .sql filename (\bsql after the dot).
  {
    const kw = detectKeyword(hay, CONTINENT_KEYWORDS.data);
    if (kw) return { continent: 'data', keyword: kw };
  }
  // 6. ui_ux — style/markup extensions, then keywords
  if (/\.(css|scss|jsx|tsx|vue|svelte)$/.test(base)) {
    return { continent: 'ui_ux', keyword: 'ui' };
  }
  {
    const kw = detectKeyword(hay, CONTINENT_KEYWORDS.ui_ux);
    if (kw) return { continent: 'ui_ux', keyword: kw };
  }
  // 7. math
  {
    const kw = detectKeyword(hay, CONTINENT_KEYWORDS.math);
    if (kw) return { continent: 'math', keyword: kw };
  }
  // 8. logic — fallback
  return { continent: 'logic', keyword: null };
}

function classifyContinent(filePath, text) {
  return classifyContinentDetailed(filePath, text).continent;
}

// SQLite blobs come back as freshly-allocated Buffers (byteOffset 0), but copy
// defensively if a non-4-aligned offset ever slips through so the Float32Array view
// can't throw "start offset must be a multiple of 4".
function toFloat32(buf) {
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// Running mean of the centroid over n existing members plus the new embedding, then
// RE-NORMALIZE to unit length (cosineSimilarity is a bare dot product that assumes
// unit vectors): c' = (c*n + e)/(n+1), c' /= |c'|.
function runningMean(centroidBuf, embeddingBuf, n) {
  const c = toFloat32(centroidBuf);
  const e = toFloat32(embeddingBuf);
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) {
    out[i] = (c[i] * n + e[i]) / (n + 1);
  }
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return Buffer.from(out.buffer);
}

// Resolve a non-colliding node_id for a fresh country. Numeric-suffix dedupe: if the
// seeded node_id already exists (a genuinely different feature that happens to share
// a seed name), append -2, -3, … so the two features stay separate.
function uniqueNodeId(db, continent, seedName) {
  let country = seedName;
  let nodeId = continent + '/' + country;
  let n = 2;
  while (db.getFeature(nodeId)) {
    country = seedName + '-' + n;
    nodeId = continent + '/' + country;
    n++;
  }
  return { country, nodeId };
}

// Single entry point. Always returns { node_id, continent, country }; node_id is NEVER
// null (F1/degraded guarantee). `db` is a project-scoped proxy; `projectPath` is
// accepted for call-site symmetry but intentionally unused (db already carries it).
function assignFeature({ db, filePath, description, diffText, embedding, threshold }) {
  const t = typeof threshold === 'number' ? threshold : DEFAULTS.feature_cluster_threshold;
  const text = [description, diffText].filter(Boolean).join(' ');
  const { continent, keyword } = classifyContinentDetailed(filePath, text);

  // Cold-start seed: prefer the matched semantic keyword over the basename (F2). Fall
  // back to the basename (sans extension), then a constant if nothing is derivable.
  const base = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  const baseNoExt = base.replace(/\.[^.]+$/, '');
  const seedName = normalizeCountry(keyword || baseNoExt) || 'general';

  // (2) embedding present → nearest-centroid clustering within the continent.
  if (embedding) {
    const candidates = db.getFeaturesByContinent(continent);
    let best = null;
    let bestSim = -Infinity;
    for (const f of candidates) {
      if (!f.centroid_embedding) continue;
      const sim = cosineSimilarity(embedding, f.centroid_embedding);
      if (sim > bestSim) { bestSim = sim; best = f; }
    }
    if (best && bestSim >= t) {
      // Join: running-mean update + member_count++ (upsert increments internally).
      const newCentroid = runningMean(best.centroid_embedding, embedding, best.member_count);
      db.upsertFeatureCentroid({ continent, country: best.country, node_id: best.node_id, embedding: newCentroid });
      return { node_id: best.node_id, continent, country: best.country };
    }
    // Heal a degraded orphan before forking. A same-seed feature created earlier while
    // the model was still downloading has a NULL centroid, so the clustering loop above
    // skipped it — leaving uniqueNodeId to fork the SAME logical feature to seed-2. If
    // such an orphan exists, adopt it instead: upsert with an embedding sets its centroid
    // and increments member_count, converting the placeholder into this embedded feature
    // (one country per feature across the lazy-download boundary — F1/F2).
    const orphan = candidates.find(
      (f) => !f.centroid_embedding && f.node_id === continent + '/' + seedName
    );
    if (orphan) {
      db.upsertFeatureCentroid({ continent, country: orphan.country, node_id: orphan.node_id, embedding });
      return { node_id: orphan.node_id, continent, country: orphan.country };
    }
    // New country seeded from this embedding.
    const { country, nodeId } = uniqueNodeId(db, continent, seedName);
    db.upsertFeatureCentroid({ continent, country, node_id: nodeId, embedding });
    return { node_id: nodeId, continent, country };
  }

  // (3) embedding absent (degraded) → node_id = continent/seed DIRECTLY, no dedupe.
  // Without an embedding we can't tell features apart, so same-seed degraded changes
  // JOIN the same country (upsert moves member_count, centroid stays NULL). node_id is
  // STILL written — the F1/degraded guarantee.
  const country = seedName;
  const nodeId = continent + '/' + country;
  db.upsertFeatureCentroid({ continent, country, node_id: nodeId, embedding: null });
  return { node_id: nodeId, continent, country };
}

module.exports = {
  classifyContinent,
  classifyContinentDetailed,
  assignFeature,
  runningMean,
};
