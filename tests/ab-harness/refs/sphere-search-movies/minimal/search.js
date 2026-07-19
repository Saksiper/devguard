'use strict';
function searchMovies(movies, query) {
  const q = String(query).trim().toLowerCase();
  if (!q) return movies.slice();
  return movies.filter((m) => m.title.toLowerCase().includes(q));
}
module.exports = { searchMovies };
