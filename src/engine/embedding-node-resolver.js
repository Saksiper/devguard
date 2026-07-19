'use strict';

// S2.B — embedding-based read-resolver. ALTERNATIVE to the frozen keyword map:
// encode the prompt, then GLOBAL argmax of cosine similarity against every
// features.centroid_embedding (from db.getAllFeatures(), which is project_path
// scoped) → node_id above a threshold, else null.
//
// ⚠️ DEFAULT-OFF. This module is only invoked when config
// `sphere_read_resolver_enabled` is true. Enabling it calls loadModel(), which
// loads MiniLM (~all-MiniLM-L6-v2) INSIDE the UserPromptSubmit hook. That hook is
// synchronous per prompt turn, so the model load + encode adds latency to EVERY
// prompt the user sends. CLAUDE.md bans model loads in PreToolUse; UserPromptSubmit
// is a different hook but the same synchronous-cost reasoning applies. Keep this OFF
// until an N>=20 live latency measurement justifies it. Tests inject a fake encoder
// via `deps` and NEVER load the real model.

/**
 * Resolve a node_id from prompt text via embedding argmax over feature centroids.
 * @param {object} db  project-scoped db proxy exposing getAllFeatures()
 * @param {string} promptText
 * @param {number} threshold  minimum cosine similarity to accept the argmax
 * @param {object} [deps]  {loadModel, encode, cosineSimilarity} — injected in tests
 * @returns {Promise<string|null>}
 */
async function resolveNodeIdByEmbedding(db, promptText, threshold, deps = {}) {
  if (typeof promptText !== 'string' || promptText.length === 0) return null;

  const emb = require('./embedding');
  const loadModel = deps.loadModel || emb.loadModel;
  const encode = deps.encode || emb.encode;
  const cosineSimilarity = deps.cosineSimilarity || emb.cosineSimilarity;

  const model = await loadModel();
  if (!model) return null;

  const promptVec = await encode(promptText);
  if (!promptVec) return null;

  const features = db.getAllFeatures();
  let best = null;
  let bestSim = -Infinity;
  for (const f of features) {
    if (!f.centroid_embedding) continue;
    const sim = cosineSimilarity(promptVec, f.centroid_embedding);
    // Strict '>' keeps the FIRST feature on a tie; getAllFeatures orders by
    // (continent ASC, member_count DESC, id ASC), so ties are deterministic.
    if (sim > bestSim) {
      bestSim = sim;
      best = f;
    }
  }

  return best && bestSim >= threshold ? best.node_id : null;
}

module.exports = { resolveNodeIdByEmbedding };
