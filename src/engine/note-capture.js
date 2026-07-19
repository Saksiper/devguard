'use strict';

const { getLastAssistantText } = require('./transcript-parser');
const { parseMarker, parseAckTags } = require('./dg-note');
const { isValidNodeId } = require('./node-taxonomy');
const { recordCanary } = require('./sphere-canary');
const { sanitize } = require('./sanitize');
const { computeFileFingerprint } = require('./file-fingerprint');

// Match a DG-NOTE token even when it doesn't form a valid marker, so we can tell
// "wrong zone" (node_unresolved) apart from "broken syntax" (marker_malformed).
const NODE_TOKEN_RE = /\[DG-NOTE\s+([^\]\s]+)/;

// Capture a sphere note from the LAST assistant reply in a transcript.
//
// Markers carry no tool_use_id, so idempotency is CONTENT-based. Because
// db.insertNote sanitizes note_text on write, we compare against the SANITIZED
// form (otherwise non-ASCII notes defeat the check and Stop + SessionEnd both
// write). The whole read-check-write runs in one transaction so concurrent
// Stop(async) + SessionEnd can't both insert (the second re-reads the head).
//
// The caller (hook) owns try/catch and exit-0 non-blocking semantics.
function captureNoteFromTranscript(db, { transcriptPath, sessionId } = {}) {
  const text = getLastAssistantText(transcriptPath);
  recordCanary('fired', { sessionId });

  const marker = parseMarker(text || '');
  if (!marker) {
    if (text && text.includes('[DG-NOTE')) {
      const m = text.match(NODE_TOKEN_RE);
      if (m && !isValidNodeId(m[1])) recordCanary('node_unresolved', { token: m[1] });
      else recordCanary('marker_malformed', {});
    }
    return null;
  }

  const clean = sanitize(marker.text); // compare against the stored (sanitized) form
  if (clean === '') { recordCanary('marker_malformed', {}); return null; } // empty post-sanitize (e.g. zero-width only) — don't store/supersede with an empty note

  return db.transaction(() => {
    const head = db.getHeadNoteByNode(marker.nodeId);
    if (head && head.note_text === clean) {
      return head.id; // already captured — do NOT insert/supersede again.
    }

    // S3.3.4: attribute the note to the session's latest edit — but ONLY when that
    // edit is plausibly the one this marker annotates. A nodeId-only marker carries no
    // edit correlation, so we require the S1 classifier to independently place the
    // latest change under the SAME feature the marker names (or to have left it
    // unclassified). When the classifier node DIFFERS we cannot tell "the classifier
    // mislabeled THIS edit" from "the marker is about a DIFFERENT feature than the
    // latest edit" (multi-feature or reflection-only turn), so we neither link
    // related_change_id nor merge. Merging on that inequality was destructive and
    // irreversible: it could fuse two unrelated feature nodes with no un-merge path.
    const recent = db.getChanges({ session_id: sessionId, limit: 1 });
    const change = recent && recent[0];
    const attributable = !!change && (!change.node_id || change.node_id === marker.nodeId);

    // Fingerprint the file this note concerns so a later surface can flag the note
    // stale when the file changed since. Tied to attributability: an unrelated edit's
    // file must not be pinned to this note. computeFileFingerprint is fail-safe (null
    // on a missing/oversize/unreadable file — capture still succeeds).
    //
    // KNOWN LIMITATION (accepted, watch in dogfood): only the LATEST edited file is
    // pinned. A feature that spans multiple files gets just one of them fingerprinted,
    // so a later change to a *different* file of the same feature won't flag the note
    // stale (an under-flag). Ship the simple whole-file/single-file version first;
    // revisit with multi-file fingerprints only if this proves misleading in practice.
    const sourceFile = attributable && change.file ? change.file : null;
    const codeFingerprint = sourceFile ? computeFileFingerprint(sourceFile) : null;

    const newId = db.insertNote({
      node_id: marker.nodeId,
      source: 'yol2_claude',
      note_text: marker.text, // insertNote sanitizes; stored value == clean
      file: marker.nodeId,
      confidence_level: 3,
      session_id: sessionId,
      related_change_id: attributable ? change.id : null,
      source_file: sourceFile,
      code_fingerprint: codeFingerprint,
    });
    db.supersedePriorHead(marker.nodeId, newId);
    db.insertNoteEvent({
      note_id: newId,
      session_id: sessionId,
      event_type: 'layered',
      payload: { node_id: marker.nodeId },
    });
    recordCanary('marker_found', { nodeId: marker.nodeId });
    return newId;
  });
}

// Harvest [DG-CONTINUE/PIVOT/PAUSE] acknowledgment tags from the LAST assistant
// reply and credit the session's surfaced notes ('complied'). Must run AFTER
// captureNoteFromTranscript in the hooks: the reply's DG-NOTE layers the new head
// first, so the ack lands on the surfaced note without a head-advance check.
function captureAckCompliance(db, { transcriptPath, sessionId } = {}) {
  if (!sessionId) return 0;
  const tags = parseAckTags(getLastAssistantText(transcriptPath) || '');
  let emitted = 0;
  for (const tag of tags) {
    if (!tag.nodeToken) {
      // A bare tag is also the cycle-warn directive's answer format; crediting it
      // would count cycle answers as sphere compliance. The canary measures how
      // often models drop the echo (informs a future token-namespace split).
      recordCanary('ack_echoless', { outcome: tag.outcome });
      continue;
    }
    if (!isValidNodeId(tag.nodeToken)) {
      recordCanary('ack_node_unresolved', { token: tag.nodeToken });
      continue;
    }
    const res = db.ackNoteCompliance(sessionId, {
      outcome: tag.outcome,
      nodeId: tag.nodeToken,
      reason: tag.reason,
    });
    if (res.emitted > 0) {
      emitted += res.emitted;
      recordCanary('ack_found', { nodeId: tag.nodeToken, outcome: tag.outcome });
    } else {
      recordCanary('ack_unmatched', { nodeId: tag.nodeToken });
    }
  }
  return emitted;
}

module.exports = { captureNoteFromTranscript, captureAckCompliance };
