'use strict';
const YEAR_RE = /^\d{4}$/;
const ARTICLE_RE = /^the\s+/i;

function normalizeTitle(text) {
  return text.replace(ARTICLE_RE, '').toLowerCase();
}

function searchMovies(movies, query) {
  const tokens = String(query).trim().split(/\s+/).filter(Boolean);
  let year;
  const titleTokens = [];
  for (const tok of tokens) {
    if (YEAR_RE.test(tok)) {
      year = Number(tok);
    } else {
      titleTokens.push(tok);
    }
  }
  const titleQuery = normalizeTitle(titleTokens.join(' '));

  return movies
    .filter((m) => {
      if (year !== undefined && m.year !== year) return false;
      if (titleQuery && !normalizeTitle(m.title).includes(titleQuery)) return false;
      return true;
    })
    .sort((a, b) => b.year - a.year);
}
module.exports = { searchMovies };
