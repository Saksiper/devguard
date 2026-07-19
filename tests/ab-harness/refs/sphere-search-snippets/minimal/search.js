'use strict';
function searchSnippets(snippets, query) {
  const q = (typeof query === 'string' ? query : '').toLowerCase();
  return snippets.filter((s) => s.title.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));
}
module.exports = { searchSnippets };
