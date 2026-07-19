'use strict';

const { readInput, respond, context } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');
const { resolveNodeId } = require('../engine/keyword-node-map');
const { formatFeatureSection } = require('../engine/dg-note');
const { isNoteStale } = require('../engine/file-fingerprint');
const { loadConfig } = require('../engine/config');

// Node resolution seam. The per-project keyword index LEADS (DEFAULT-ON): it weighs
// the WHOLE prompt against the project's own notes (rare-term overlap + margin gate),
// so it resolves to the actually-relevant node instead of firing on a single stray
// keyword. The frozen keyword map surfaced e.g. 'ui_ux/filter' for ANY prompt that
// merely contained the word 'filter' (false surfaces, measured live) — it is now only
// a legacy escape hatch, used when the index is explicitly disabled. When the index
// defers (ambiguous/weak, returns null) we do NOT fall back to the crude keyword match;
// the embedding argmax is the only remaining path, and it loads MiniLM (~680ms cold)
// so it stays behind sphere_read_resolver_enabled (DEFAULT-OFF).
// `deps` injects a fake encoder in tests (no real model).
async function resolveFeatureNodeId(db, promptText, config, deps) {
  if (config.keyword_index_enabled !== false) {
    const { resolveByProjectIndex } = require('../engine/keyword-index');
    const indexNode = resolveByProjectIndex(db, promptText, config.keyword_index_margin);
    if (indexNode) return indexNode;
    // Index deferred. A keyword may still NAME a note-LESS feature so the "leave a
    // note" nudge works — but we NEVER surface a bare-keyword node that already HAS a
    // note. That stray-word match was the false surface (a prompt merely saying
    // 'filter' pulled up the filter note); the index, not a passing word, decides
    // which EXISTING note shows.
    try {
      const kw = resolveNodeId(promptText);
      if (kw && db.getHeadNoteByNode && !db.getHeadNoteByNode(kw)) return kw;
    } catch { /* db mock without getHeadNoteByNode — skip the bootstrap path */ }
  } else {
    const keywordNode = resolveNodeId(promptText); // legacy: frozen keyword map only
    if (keywordNode) return keywordNode;
  }
  if (config.sphere_read_resolver_enabled) {
    const { resolveNodeIdByEmbedding } = require('../engine/embedding-node-resolver');
    return resolveNodeIdByEmbedding(db, promptText, config.feature_cluster_threshold, deps);
  }
  return null;
}

async function main() {
  const timer = createTimer('user-prompt-submit');
  timer.start();

  try {
    const input = readInput();
    debugLog('user-prompt-submit', 'raw input keys', { keys: Object.keys(input) });
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());

    const db = getDb(projectPath);
    const config = loadConfig(projectPath);
    // Attribute to the session that submitted THIS prompt. getLatestSession() is
    // only a fallback for payloads without session_id — the newest 'sessions' row
    // can belong to a concurrent headless `claude -p`, so trusting it would
    // hijack pending-summary consume and surfaced-event attribution.
    const latest = db.getLatestSession();
    const sessionId = input.session_id || (latest && latest.session_id) || null;

    if (!sessionId) {
      closeDb();
      timer.elapsed('No session');
      respond({});
      return;
    }

    const pending = db.consumePendingSummary(sessionId);

    // Sphere proactive read: if the prompt names a known feature, surface its
    // current note (or, if none, instruct Claude to leave one). Own try/catch so
    // it can never break the pending-summary path (non-blocking).
    let featureBlock = null;
    try {
      // Claude Code UserPromptSubmit payload field is `prompt` (verified via live
      // payload capture 2026-07-01); readInput does no field normalization.
      const promptText = input.prompt || '';
      // Keyword map (model-free, default) OR embedding argmax. The embedding path
      // (sphere_read_resolver_enabled) is DEFAULT-OFF because it loads MiniLM
      // synchronously on every prompt turn — see resolveFeatureNodeId above.
      const nodeId = await resolveFeatureNodeId(db, promptText, config);
      if (nodeId) {
        const head = db.getHeadNoteByNode(nodeId);
        // Per-session cooldown: a node's note surfaces once per session — Claude
        // already has it in context, and every repeat forces another ack layer onto
        // the node (measured live: 3 surfaces + 3 bookkeeping layers in one session).
        // Note-less bootstrap (head=null) is not gated: no event, no layer risk.
        const cooled = !!head && db.hasSurfacedNodeInSession(nodeId, sessionId);
        if (cooled) {
          debugLog('user-prompt-submit', 'Surface cooldown: node already surfaced this session', { nodeId });
        } else {
          // Flag the note stale if its source file changed since capture (fail-safe:
          // isNoteStale is false for null/old/unattributable notes). Read-only IO here,
          // off the pre-edit hot path.
          featureBlock = formatFeatureSection(nodeId, head ? head.note_text : null, { stale: isNoteStale(head) });
          // Only record a 'surfaced' event when we actually surface. In passive mode
          // (intervention_enabled=false) nothing is injected, so recording 'surfaced'
          // would count a phantom surface and poison the A/B metric.
          if (head && config.intervention_enabled) {
            db.insertNoteEvent({
              note_id: head.id,
              session_id: sessionId,
              event_type: 'surfaced',
              payload: { node_id: nodeId, trigger: 'user_prompt' },
            });
          }
          debugLog('user-prompt-submit', 'Feature note resolved', { nodeId, hasHead: !!head });
        }
      }
    } catch (e) {
      debugLog('user-prompt-submit', 'Feature note step failed (non-fatal)', { error: String(e) });
    }

    closeDb();

    // A/B passive mode: everything above still runs (node resolution is harmless), but
    // NOTHING reaches Claude — no pending summary, no feature note — and no 'surfaced'
    // event was written above. Injection is fully suppressed.
    if (!config.intervention_enabled) {
      timer.elapsed('Passive mode (no injection)');
      respond({});
      return;
    }

    // Pending summary first, feature note as a separate block after it.
    const parts = [];
    if (pending) parts.push(pending);
    if (featureBlock) parts.push(featureBlock);

    if (parts.length) {
      timer.elapsed('Injected');
      context(parts.join('\n\n'), 'UserPromptSubmit');
    } else {
      timer.elapsed('Nothing to inject');
      respond({});
    }
  } catch (err) {
    debugLog('user-prompt-submit', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveFeatureNodeId };
