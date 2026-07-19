'use strict';
// A realistic "never saw the decisions" implementation: a lazy-but-sane model
// reading only { id, title, headings } would naturally search both fields,
// case-insensitively, with an empty-query guard — no '#' heading-only prefix,
// no OR-across-words handling. Kept to document that the true differentiator
// between arms is C1 and C2, not a strawman-weak baseline (see minimal/).
function searchDocs(docs, query) {
  if (typeof query !== 'string') return [];
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return docs.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.headings.some((h) => h.toLowerCase().includes(q))
  );
}
module.exports = { searchDocs };
