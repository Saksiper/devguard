'use strict';

// DG-NOTE marker contract for the sphere layer.
// Production language is English (prompt language = product language).
// This module is pure (no IO). formatInstruction is used BOTH by the behavioral
// spike and by production, so the two never diverge.

/**
 * Build the instruction injected into Claude's context for a feature node.
 * @param {string} nodeId  "continent/country", e.g. "ui_ux/filter"
 * @param {string|null} priorNote  the current head note for this node, or falsy if none
 * @returns {string}
 */
function formatInstruction(nodeId, priorNote) {
  const marker = `[DG-NOTE ${nodeId}]`;
  const pastTenseRule =
    ' Describe only what THIS edit did, in past tense; do NOT write future plans or intentions.';
  if (!priorNote) {
    return (
      `No prior note exists for feature \`${nodeId}\`. ` +
      `When you finish this task, leave one past-tense, single-sentence note at the end of your reply: ` +
      `${marker} <what you changed and why>.` +
      pastTenseRule
    );
  }
  // The ack tag echoes the node so the Stop-hook harvest can match it back to THIS
  // surfaced note (the compliance anchor); asked at the END of the reply, in one
  // block with the DG-NOTE marker, because a turn-start tag lands before any edit
  // anchor and the retrospective capture would structurally never see it.
  return (
    `Prior note for feature \`${nodeId}\`: "${priorNote}". ` +
    `Respect this earlier decision and build on it. ` +
    `When you finish, END your reply with this two-line block:\n` +
    `[DG-CONTINUE ${nodeId}] <one past-tense sentence: how you followed the note>\n` +
    `${marker} <one past-tense sentence: what you changed and why>\n` +
    `Use [DG-PIVOT ${nodeId}] instead if you deliberately diverged, or ` +
    `[DG-PAUSE ${nodeId}] if you must investigate first.` +
    pastTenseRule
  );
}

// Header for the surfaced-note section. UserPromptSubmit concatenates the pending
// summary and the feature note into one additionalContext; without a delimiter the
// two blocks bleed together (the pre-S2.A bug). This makes the surfaced note a
// discrete, labeled section. Header is emitted ONLY when a head note exists — the
// "leave a note" instruction (no prior note) needs no header.
const FEATURE_SECTION_HEADER = '── DevGuard Feature Note ──';

/**
 * Render the feature block as a discrete section. When a prior head note exists,
 * the instruction is placed under a labeled header; when none exists, the bare
 * "leave a note" instruction is returned with NO header (nothing to surface yet).
 * Used by both the behavioral spike and production so they never diverge.
 * @param {string} nodeId
 * @param {string|null} priorNote  current head note for this node, or falsy if none
 * @param {{stale?: boolean}} [opts]  stale=true appends a re-verify warning (the
 *   caller computes staleness via file-fingerprint; this stays pure/no-IO)
 * @returns {string}
 */
function formatFeatureSection(nodeId, priorNote, opts = {}) {
  const body = formatInstruction(nodeId, priorNote);
  if (!priorNote) return body; // no head note: nothing to re-verify, stale is moot
  const staleLine = opts.stale
    ? '\n⚠ The source file changed since this note was written — re-verify it still applies.'
    : '';
  return `${FEATURE_SECTION_HEADER}\n${body}${staleLine}`;
}

const { isValidNodeId } = require('./node-taxonomy');

// node_id capture excludes ']' and whitespace (so '[DG-NOTE id ]' with a trailing
// space still parses); the note text is non-greedy and stops at the next marker,
// newline, or end so two markers on one line don't merge into one.
const MARKER_RE = /\[DG-NOTE\s+([^\]\s]+)\s*\]\s*([^\n]*?)(?=\s*\[DG-NOTE|\n|$)/g;

/**
 * Extract the LAST DG-NOTE marker from a reply.
 * @param {string} text  Claude's reply containing a marker at the end.
 * @returns {{nodeId: string, text: string}|null}
 */
function parseMarker(text) {
  if (typeof text !== 'string') return null;
  // Keep the last VALID marker (not the last token then validate) — so a valid
  // marker followed by an invalid [DG-NOTE] quote later in the text isn't lost.
  let last = null;
  for (const m of text.matchAll(MARKER_RE)) {
    if (isValidNodeId(m[1])) last = m;
  }
  if (!last) return null;
  const text2 = last[2].trim();
  if (text2 === '') return null; // bare marker with no note text is not a usable note
  return { nodeId: last[1], text: text2 };
}

// Ack tags may echo the surfaced node ([DG-CONTINUE ui_ux/filter]) so the Stop-hook
// harvest can match the acknowledgment back to the surfaced note in the note's own
// namespace; the bare form ([DG-CONTINUE]) parses with a null token. Reason stops at
// the next DG marker or line end so the paired [DG-NOTE] never bleeds into it.
const ACK_RE = /\[DG-(CONTINUE|PIVOT|PAUSE)(?:\s+([^\]\s]+))?\s*\]\s*([^\n]*?)(?=\s*\[DG-|\n|$)/gi;

/**
 * Extract every DG acknowledgment tag from a reply, in order. Node tokens are NOT
 * validated here (pure parser) — the caller checks isValidNodeId.
 * @param {string} text
 * @returns {Array<{outcome: string, nodeToken: string|null, reason: string}>}
 */
function parseAckTags(text) {
  if (typeof text !== 'string') return [];
  const tags = [];
  for (const m of text.matchAll(ACK_RE)) {
    tags.push({ outcome: 'dg_' + m[1].toLowerCase(), nodeToken: m[2] || null, reason: m[3].trim() });
  }
  return tags;
}

module.exports = { formatInstruction, formatFeatureSection, parseMarker, parseAckTags };
