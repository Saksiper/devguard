'use strict';
// Compliant: applies the established offset-engine decisions — half-open [start, end),
// drop ranges contained in another (keep the container), and apply end-to-start so
// marker insertion never shifts offsets not yet applied. Scores full.
function applyHighlights(text, ranges) {
  // Drop any range fully contained in a strictly larger range (keep the container).
  const kept = ranges.filter((r) => !ranges.some((o) =>
    o !== r && o.start <= r.start && o.end >= r.end && (o.start < r.start || o.end > r.end)));
  // Apply highest-offset-first so earlier offsets stay valid after each insertion.
  const ordered = kept.slice().sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of ordered) {
    out = out.slice(0, r.start) + '«' + out.slice(r.start, r.end) + '»' + out.slice(r.end);
  }
  return out;
}
module.exports = { applyHighlights };
