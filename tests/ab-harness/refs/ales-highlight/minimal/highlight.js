'use strict';
// Minimal: the laziest correct wrapper — inclusive end, wraps every range in input
// order, slicing the mutating string with original offsets. Correct on a single
// sorted off-boundary range (the acceptance test), but never saw the offset-engine
// decisions, so it scores 0: inclusive end, nested markers on overlap, and drift on
// out-of-order input.
function applyHighlights(text, ranges) {
  let out = text;
  for (const r of ranges) {
    out = out.slice(0, r.start) + '«' + out.slice(r.start, r.end + 1) + '»' + out.slice(r.end + 1);
  }
  return out;
}
module.exports = { applyHighlights };
