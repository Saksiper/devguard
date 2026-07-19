'use strict';
function searchDocs(docs, query) {
  if (typeof query !== 'string') return [];
  const q = query.trim();
  if (q.length === 0) return [];
  if (q.startsWith('#')) {
    const heading = q.slice(1);
    return docs.filter((d) => d.headings.some((h) => h.includes(heading)));
  }
  const words = q.split(/\s+/);
  return docs.filter((d) =>
    words.some((w) => d.title.includes(w) || d.headings.some((h) => h.includes(w)))
  );
}
module.exports = { searchDocs };
