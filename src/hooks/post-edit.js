'use strict';

const { readInput, respond } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');
const { resolveLines } = require('../engine/line-resolver');
const { createTempProtection } = require('../engine/protection');
const { invalidateFile } = require('../engine/blame-cache');
const { normalizePath } = require('../engine/normalize-path');
const { findResponseAfter, findLastEditToolUseId } = require('../engine/transcript-parser');
const { generateProtectNote } = require('../engine/protect-heuristic');
const { assignFeature } = require('../engine/feature-classifier');

const MAX_DIFF_LENGTH = 10240; // 10KB — consistent with post-command.js
const VERDICT_MAX = 500; // findResponseAfter returns uncapped text; parseTranscript used to cap at 500.
const RETRO_CANDIDATES = 5; // mirror trackDetectionOutcome's bounded scan of pending rows.

function truncate(text) {
  if (!text || text.length <= MAX_DIFF_LENGTH) return text;
  return text.substring(0, MAX_DIFF_LENGTH);
}

// STEP 1 fallback — recover THIS edit's tool_use_id when the hook payload lacks the
// field (older clients only; current clients send input.tool_use_id directly): scan
// the transcript TAIL for the last edit-family tool_use whose file matches this edit.
// Tail (not head): a >4MB session — exactly what retrospective attribution targets —
// would otherwise fall outside extractEdits' head-anchored 4MB window and lose the
// anchor. Matching the tool_use line directly also means we don't depend on the
// tool_result being flushed yet. This anchor is persisted on the change row so a
// LATER post-edit (or the session-close flush) can attribute its DG-tag reply back.
function recoverToolUseId(transcriptPath, filePath) {
  return findLastEditToolUseId(transcriptPath, filePath);
}

// STEP 2/3/5 — retrospective attribution. PostToolUse fires BEFORE this edit's own reply
// exists, so anchoring on it always returns null. Instead, for each PRIOR change in this
// session that has a tool_use_id but no verdict yet, find its DG-tag reply (now present in
// the transcript) with the user-turn guard on, then persist verdict + detection outcome +
// note compliance against that PRIOR change. Non-fatal per candidate.
function attributeRetrospectiveVerdicts(db, sessionId, transcriptPath, currentChangeId) {
  if (!transcriptPath) return;
  let candidates;
  try {
    candidates = db.getChanges({ session_id: sessionId })
      .filter(c => c.tool_use_id && !c.claude_verdict && c.id !== currentChangeId)
      .slice(0, RETRO_CANDIDATES);
  } catch (err) {
    debugLog('post-edit', 'retro candidate scan failed (non-fatal)', { error: String(err) });
    return;
  }

  for (const prior of candidates) {
    let reply;
    try {
      reply = findResponseAfter(transcriptPath, prior.tool_use_id, { stopAtUserTurn: true });
    } catch (err) {
      debugLog('post-edit', 'findResponseAfter failed (non-fatal)', { error: String(err) });
      continue;
    }
    if (!reply) continue; // no reply yet (or a user turn intervened) — leave for a later pass
    const capped = reply.length > VERDICT_MAX ? reply.slice(0, VERDICT_MAX) : reply;

    try { db.updateChangeVerdict(prior.id, capped, 3); } catch (err) {
      debugLog('post-edit', 'updateChangeVerdict failed (non-fatal)', { error: String(err) });
    }
    // claude_verdict is raw reasoning; only LABEL the prior's already-linked detections
    // here (they were linked to THIS prior's change at its own insert time). Re-linking
    // would scoop THIS edit's still-unlinked detection onto the prior (off-by-one).
    // Note compliance is NOT scored here: the edit's assignFeature node and the
    // surfaced note's keyword-map node are disjoint namespaces, so an edit-anchored
    // score either never fires or mis-fires. The Stop/SessionEnd ack harvest
    // (captureAckCompliance + finalizeNoteCompliance) owns compliance now.
    try { db.labelDetectionOutcome(sessionId, prior.id, capped); } catch (err) {
      debugLog('post-edit', 'labelDetectionOutcome failed (non-fatal)', { error: String(err) });
    }
  }
}

function extractIssueTitle(errorString) {
  if (!errorString) return null;
  const firstLine = errorString.split('\n')[0].trim();
  if (!firstLine) return null;
  const cleaned = firstLine.replace(/^(Error|TypeError|ReferenceError|SyntaxError):\s*/i, '');
  return cleaned.substring(0, 100) || null;
}

function handleIssueLifecycle(db, sessionId, filePath, changeId) {
  try {
    const recentErrors = db.getErrorOutputs({ session_id: sessionId, limit: 1 });
    if (recentErrors.length === 0) return null;

    const title = extractIssueTitle(recentErrors[0].error_string);
    if (!title) return null;

    const existingIssues = db.getIssues({ status: 'open' });
    const match = existingIssues.find(i => i.title === title);

    let issueId;
    if (match) {
      issueId = match.id;
      db.updateIssueFixChange(issueId, changeId);
      debugLog('post-edit', 'Linked change to existing issue', { issueId, title });
    } else {
      issueId = db.insertIssue({ title, status: 'open' });
      db.updateIssueFixChange(issueId, changeId);
      debugLog('post-edit', 'Created new issue', { issueId, title });
    }

    return issueId;
  } catch (err) {
    debugLog('post-edit', 'Issue lifecycle failed (non-fatal)', { error: String(err) });
    return null;
  }
}

function handleTempProtection(db, issueId, changeId, filePath, firstRange) {
  try {
    if (!firstRange) return;

    createTempProtection(db, {
      issueId,
      changeId,
      file: filePath,
      startLine: firstRange.start,
      endLine: firstRange.end,
    });
    debugLog('post-edit', 'Temp protection created', { file: filePath, start: firstRange.start, end: firstRange.end });
  } catch (err) {
    debugLog('post-edit', 'Temp protection failed (non-fatal)', { error: String(err) });
  }
}

// Load the model once and RETURN the embedding buffer (or null). Caller decides
// whether to persist it and reuses the same buffer for node_id clustering — no double
// compute. Model load is legal here (PostToolUse async), never in pre-edit.
async function computeEmbedding(description, diffText) {
  try {
    const { loadModel, encode } = require('../engine/embedding');
    const model = await loadModel();
    if (!model) return null;

    const text = [description, diffText].filter(Boolean).join(' ');
    if (!text) return null;

    const embedding = await encode(text);
    return embedding || null;
  } catch (err) {
    debugLog('post-edit', 'Embedding compute failed (non-fatal)', { error: String(err) });
    return null;
  }
}

async function main() {
  const timer = createTimer('post-edit');
  timer.start();

  try {
    const input = readInput();
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());
    const toolInput = input.tool_input || {};
    const toolName = input.tool_name || 'Edit';
    const filePath = normalizePath(toolInput.file_path || '') || '';
    const transcriptPath = input.transcript_path || null;
    debugLog('post-edit', 'Input fields', { transcriptPath, sessionId: input.session_id, keys: Object.keys(input).join(',') });

    if (!filePath) {
      debugLog('post-edit', 'No file_path, skipping');
      timer.elapsed('No file_path');
      respond({});
      return;
    }

    // Path exclusion — don't write changes for excluded paths (symmetric with pre-edit)
    const { loadConfig } = require('../engine/config');
    const config = loadConfig(projectPath);
    const { isExcluded } = require('../engine/path-matcher');
    if (isExcluded(filePath, config, projectPath)) {
      debugLog('post-edit', 'Path excluded, skipping insert', { file: filePath });
      timer.elapsed('Path excluded');
      respond({});
      return;
    }

    const db = getDb(projectPath);
    // g2: attribute to the session that made THIS edit — payload session_id first.
    // getLatestSession() is only a fallback for older clients; under concurrent
    // sessions the newest row is the WRONG session.
    const latest = db.getLatestSession();
    const sessionId = input.session_id || (latest && latest.session_id) || null;

    if (!sessionId) {
      debugLog('post-edit', 'No active session, skipping');
      closeDb();
      timer.elapsed('No session');
      respond({});
      return;
    }

    // Write sends `content`, not new_string/old_string — mirror transcript-parser's
    // describeEdit/diffForEdit mapping so live Write rows match backfilled ones and
    // stay visible to embedding, clustering, FTS and diff-match.
    const newText = toolInput.new_string ?? toolInput.content;
    const oldText = toolInput.old_string ?? (toolName === 'Write' ? toolInput.content : undefined);

    const lineRanges = resolveLines(filePath, newText || oldText);
    const firstRange = (lineRanges && lineRanges.length > 0) ? lineRanges[0] : null;

    const description = truncate(newText) || null;
    const diffText = truncate(oldText) || null;

    // THIS edit's verdict is NOT captured here: PostToolUse fires before the reply
    // exists in the transcript. claude_verdict stays null now and is patched in
    // retrospectively on a later post-edit (see attributeRetrospectiveVerdicts).
    let verdictQuality = 1;
    const claudeVerdict = null;
    try {
      const recentErrors = db.getErrorOutputs({ session_id: sessionId, limit: 1 });
      if (recentErrors.length > 0) verdictQuality = 2;
    } catch { /* non-fatal */ }

    // STEP 1 — this edit's tool_use_id as the future retrospective anchor. Current
    // clients (terminal AND Desktop, live-verified) send it in the PostToolUse
    // payload; fall back to transcript-tail recovery for older clients.
    const toolUseId = input.tool_use_id || recoverToolUseId(transcriptPath, filePath);

    let protectNote = null;
    try {
      protectNote = generateProtectNote({
        filePath,
        action: toolName,
        newCode: newText,
        oldCode: oldText,
      });
    } catch (e) {
      debugLog('post-edit', 'protect-heuristic threw', { msg: e && e.message });
    }

    const changeData = {
      session_id: sessionId,
      file: filePath,
      lines_start: firstRange ? firstRange.start : null,
      lines_end: firstRange ? firstRange.end : null,
      diff_text: diffText,
      description: description,
      action: toolName,
      verdict_quality: verdictQuality,
      claude_verdict: claudeVerdict,
      protect_note: protectNote,
      tool_use_id: toolUseId,
    };
    let changeId;
    try {
      changeId = db.insertChange(changeData);
    } catch (err) {
      // Only a (project_path, tool_use_id) UNIQUE collision means "this edit is
      // already recorded" (e.g. backfill imported it). Reuse that row — retrying
      // with a nulled anchor would create a duplicate invisible to backfill's
      // dedup. Anything else is a real failure for the outer catch.
      if (!(err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && toolUseId)) throw err;
      const existing = db.getChangeByToolUseId(toolUseId);
      if (!existing) throw err;
      changeId = existing.id;
      debugLog('post-edit', 'insertChange dedup — reusing existing row', { changeId, toolUseId });
    }

    // Link THIS edit's detections to THIS change at insert time (1:1, temporal). Outcome
    // is left NULL and labeled retrospectively once this edit's DG-tag reply exists. Doing
    // it here (not in the retro loop) keeps each detection bound to its own change.
    try { db.linkDetectionsToChange(sessionId, changeId, filePath); } catch (err) {
      debugLog('post-edit', 'linkDetectionsToChange failed (non-fatal)', { error: String(err) });
    }

    const issueId = handleIssueLifecycle(db, sessionId, filePath, changeId);

    if (issueId) {
      handleTempProtection(db, issueId, changeId, filePath, firstRange);
    }

    // STEP 2/3/5 — attribute DG-tag replies to the PRIOR edits that triggered them
    // (this edit's own reply is not in the transcript yet). Patches claude_verdict,
    // detection outcome, and note compliance onto those earlier changes.
    attributeRetrospectiveVerdicts(db, sessionId, transcriptPath, changeId);

    try { invalidateFile(db, filePath); } catch (err) {
      debugLog('post-edit', 'Blame invalidation failed (non-fatal)', { error: String(err) });
    }

    debugLog('post-edit', 'Change recorded', {
      file: filePath, action: toolName, sessionId, issueId,
    });

    // Semantic placement (S1): every change gets a node_id UNCONDITIONALLY. When
    // embeddings are enabled we compute ONE embedding, persist it, AND reuse it to
    // refine the country via nearest-centroid clustering. When disabled (or the model
    // fails to load) the continent heuristic still produces a node_id. One try/catch,
    // non-blocking — a failure here must never lose the already-recorded change.
    try {
      let emb = null;
      if (config.embedding_enabled) {
        emb = await computeEmbedding(description, diffText); // ONE model load, PostToolUse (legal)
        if (emb) db.updateChangeEmbedding(changeId, emb);
      }
      const { node_id } = assignFeature({
        db, projectPath, filePath, description, diffText,
        embedding: emb, threshold: config.feature_cluster_threshold,
      });
      db.updateChangeNodeId(changeId, node_id);
      debugLog('post-edit', 'node_id assigned', { changeId, node_id, embedded: !!emb });
    } catch (err) {
      debugLog('post-edit', 'node_id assignment failed (non-fatal)', { error: String(err) });
    }

    closeDb();
    timer.elapsed('Completed');
    respond({});
  } catch (err) {
    debugLog('post-edit', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

// Session-close flush: on Stop/SessionEnd the final assistant reply is guaranteed
// present, so sweep every still-pending prior (tool_use_id set, no verdict) and
// attribute it. Reuses the same anchor+guard machinery; currentChangeId is null
// (no edit is "current" at close) so nothing is excluded. Idempotent — verdicts
// already captured drop out of the candidate filter. Non-blocking.
function flushPendingVerdicts(db, sessionId, transcriptPath) {
  if (!sessionId || !transcriptPath) return;
  attributeRetrospectiveVerdicts(db, sessionId, transcriptPath, null);
}

module.exports = { extractIssueTitle, handleIssueLifecycle, computeEmbedding, attributeRetrospectiveVerdicts, flushPendingVerdicts };

if (require.main === module) {
  main();
}
