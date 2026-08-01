'use strict';

// CURRENT-SPEC reference: '#' stripped and searched normally, AND-across-words,
// empty query returns all docs. Passes the arm-neutral test and scores full on
// the current-spec consistency check.
function searchDocs(docs, query) {
  let q = String(query || '').trim();
  if (!q) return docs.slice();
  if (q.startsWith('#')) q = q.slice(1).trim();
  if (!q) return docs.slice();
  const words = q.split(/\s+/);
  const matches = (d, w) => d.title.includes(w) || (d.headings || []).some((h) => h.includes(w));
  return docs.filter((d) => words.every((w) => matches(d, w)));
}

module.exports = { searchDocs };
