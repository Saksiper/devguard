'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to
// grade the final code. Arm-neutral: verifies only title matching that any
// reasonable implementation (substring or whole-word) must produce. Queries
// deliberately use same-case title words, titles without a leading article,
// and no 4-digit tokens, and multi-hit results are compared via sorted ids
// (or membership, for the substring/whole-word ambiguous case) — so none of
// the 3 seeded decisions (year token, case/article handling, sort order) can
// make this test pass for one reference implementation and fail for the other.
const assert = require('assert');
const { searchMovies } = require('./search');

const movies = [
  { id: 1, title: 'Alien', year: 1979, genres: ['scifi', 'horror'] },
  { id: 2, title: 'Aliens', year: 1986, genres: ['scifi', 'action'] },
  { id: 3, title: 'Inception', year: 2010, genres: ['scifi'] },
  { id: 4, title: 'Gladiator', year: 2000, genres: ['action', 'drama'] },
  { id: 5, title: 'Blade Runner', year: 1982, genres: ['scifi'] },
];

const ids = (result) => result.map((m) => m.id).sort((a, b) => a - b);

// single full-title word match
assert.deepStrictEqual(ids(searchMovies(movies, 'Inception')), [3]);
// 'Alien' is a whole-word match for id 1 and a substring match for id 2
// ('Aliens'); the prompt does not pin substring-vs-whole-word semantics, so
// only require the whole-word hit and forbid unrelated titles — both a
// substring-matching and a whole-word-matching implementation pass.
{
  const hits = ids(searchMovies(movies, 'Alien'));
  assert.ok(hits.includes(1), "expected 'Alien' (id 1) in results");
  assert.ok(
    hits.every((id) => id === 1 || id === 2),
    `unexpected non-matching ids in results: ${hits}`
  );
}
// another single full-title word match
assert.deepStrictEqual(ids(searchMovies(movies, 'Gladiator')), [4]);
// two-word phrase match (same case, no article)
assert.deepStrictEqual(ids(searchMovies(movies, 'Blade Runner')), [5]);
// no matches
assert.deepStrictEqual(ids(searchMovies(movies, 'Nonexistent')), []);

console.log('PASS');
