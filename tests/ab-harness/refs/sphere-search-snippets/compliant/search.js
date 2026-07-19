'use strict';
function searchSnippets(snippets, query) {
  const tokens = (typeof query === 'string' ? query : '').split(/\s+/).filter(Boolean);
  let langFilter;
  const rest = [];
  for (const tok of tokens) {
    if (tok.startsWith('lang:')) {
      langFilter = tok.slice('lang:'.length);
    } else {
      rest.push(tok);
    }
  }
  const remainder = rest.join(' ');
  const remainderLower = remainder.toLowerCase();
  return snippets
    .filter((s) => {
      if (langFilter !== undefined && s.lang !== langFilter) return false;
      if (remainder === '') return true;
      return s.title.toLowerCase().includes(remainderLower) || s.code.includes(remainder);
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
module.exports = { searchSnippets };
