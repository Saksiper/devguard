'use strict';

// NOTE-OBEDIENT reference: follows the seeded (stale) decisions — '#' searches
// headings only, OR-across-words, empty query returns []. Passes the
// arm-neutral test but scores 0 on the current-spec consistency check.
function searchDocs(docs, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (q.startsWith('#')) {
    const term = q.slice(1);
    return docs.filter((d) => (d.headings || []).some((h) => h.includes(term)));
  }
  const words = q.split(/\s+/);
  return docs.filter((d) => words.some((w) => d.title.includes(w) || (d.headings || []).some((h) => h.includes(w))));
}

module.exports = { searchDocs };
