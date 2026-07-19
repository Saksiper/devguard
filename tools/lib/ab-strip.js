'use strict';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Judge leak sanitization. Before an arm's output reaches the blind pairwise
// judge, remove DevGuard-specific markers/tokens so the judge can never infer
// which output came from the active (DevGuard-on) arm. Legitimate task words
// (loop, retry, backoff, ...) are NOT DevGuard tokens and are preserved.
// extraTokens: run-specific strings only the active arm could have seen (e.g.
// the seeded node_id the read-gate injects verbatim).
function stripMarkers(text, extraTokens = []) {
  if (typeof text !== 'string') return text;
  let out = text;
  // 1a. Line-anchored DG tag (the turn-end ack/note block): strip from that line to
  //     the END of the text. A wrapped reason's continuation line would otherwise
  //     survive the line-based rule below and leak arm-identifying prose.
  out = out.replace(/^\s*\[DG-[^\]\n]*\][\s\S]*$/m, '');
  // 1b. Inline DG marker/tag with closing ] on the same line ([DG-NOTE ...],
  //    [DG-CONTINUE], [DG-PIVOT], [DG-PAUSE]): strip to end of line, keeping code before it.
  out = out.replace(/\s*\[DG-[^\]\n]*\][^\n]*/g, '');
  // 2. Multi-line / unterminated marker: '[DG-' with no ] before the newline (the
  //    marker wrapped across lines). Strip from '[DG-' to end of that line, so the
  //    arm-identifying node_id can't survive by being line-wrapped.
  out = out.replace(/\s*\[DG-[^\]\n]*$/gim, '');
  // 3. Lines echoing DevGuard-injected guidance — either the literal token or the
  //    known phrasings DevGuard injects (paraphrases carry no [DG- token but only
  //    the active arm could produce them). The PLURAL forms ("prior notes",
  //    "feature notes") are exempt: they are ordinary domain phrases in
  //    note-taking fixtures, while the injected guidance always uses the singular.
  out = out.replace(/^.*(DevGuard|prior note(?!s)|feature note(?!s)|── .* ──).*$\n?/gim, '');
  // 4. Run-specific tokens (e.g. seeded node_ids like 'ui_ux/filter'): strip the
  //    token itself, NOT the whole line — the surrounding code may be legitimate.
  for (const t of extraTokens) {
    if (!t) continue;
    out = out.replace(new RegExp(escapeRegExp(t), 'gi'), '');
  }
  return out;
}

module.exports = { stripMarkers };
