'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three (a prohibition-style check would pass
// trivially on minimal code).

let searchMovies;
try { ({ searchMovies } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: a standalone 4-digit token in the query filters by year; remaining
// words match the TITLE ONLY (not other fields). Two movies share a title
// but differ by year — only the year token disambiguates them. A distractor
// movie (id 3) matches the non-year word only through its genres, never its
// title, and shares the year with the intended hit: a plain whole-query
// substring match against the title finds none of them (the title alone
// never contains "2024"), and a multi-field token-AND match over
// title/year/genres wrongly pulls in the distractor alongside the real hit.
check('C1', () => {
  const movies = [
    { id: 1, title: 'Gladiator', year: 2000, genres: [] },
    { id: 2, title: 'Gladiator', year: 2024, genres: [] },
    { id: 3, title: 'Arena', year: 2024, genres: ['gladiator'] },
  ];
  const hits = searchMovies(movies, 'Gladiator 2024').map((m) => m.id);
  return hits.length === 1 && hits[0] === 2;
});

// C2: title matching is case-insensitive AND ignores a leading 'The '
// article, on EITHER side of the match. Checked both ways: a lowercase,
// article-free query ('matrix') must find an articled title ('The Matrix'),
// and an articled query ('The Matrix') must find an article-free title
// ('Matrix') without matching an unrelated title. An exact-case,
// article-sensitive substring check fails the first; a plain
// case-insensitive substring check (no article stripping) fails the second,
// since 'the matrix' is not a substring of 'matrix'.
check('C2', () => {
  const moviesA = [
    { id: 1, title: 'The Matrix', year: 1999, genres: [] },
    { id: 2, title: 'Amelie', year: 2001, genres: [] },
  ];
  const hitsA = searchMovies(moviesA, 'matrix').map((m) => m.id);
  const okA = hitsA.length === 1 && hitsA[0] === 1;

  const moviesB = [
    { id: 1, title: 'Matrix', year: 1999, genres: [] },
    { id: 2, title: 'Amelie', year: 2001, genres: [] },
  ];
  const hitsB = searchMovies(moviesB, 'The Matrix').map((m) => m.id);
  const okB = hitsB.length === 1 && hitsB[0] === 1;

  return okA && okB;
});

// C3: results are sorted by year descending (newest first). All three movies
// match the query; only the sort order distinguishes a compliant result from
// an insertion-order (or otherwise unsorted) one.
check('C3', () => {
  const movies = [
    { id: 1, title: 'Old One', year: 1990, genres: [] },
    { id: 2, title: 'New One', year: 2020, genres: [] },
    { id: 3, title: 'Mid One', year: 2005, genres: [] },
  ];
  const hits = searchMovies(movies, 'One').map((m) => m.id);
  return hits.join(',') === '2,3,1';
});

process.exit(fails);
