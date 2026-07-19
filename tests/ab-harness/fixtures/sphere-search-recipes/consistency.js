'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let searchRecipes;
try { ({ searchRecipes } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the query is matched against ingredients too, not just the title — but
// as an EXACT match against an ingredient-name string, not a substring. Recipe
// 2's ingredient 'banana bread mix' contains 'banana' as a substring but is
// not the ingredient 'banana', so a substring-everywhere guesser (the naive
// full-text default, and the plausible passive-arm behavior) over-matches
// recipe 2 and fails this check; a title-only implementation under-matches
// (misses recipe 1, whose title doesn't mention banana) and also fails.
check('C1', () => {
  const recipes = [
    { id: 1, title: 'morning bowl', ingredients: ['oats', 'banana', 'honey'] },
    { id: 2, title: 'evening bowl', ingredients: ['rice', 'beans', 'banana bread mix'] },
  ];
  const hits = searchRecipes(recipes, 'banana').map((r) => r.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: results are ordered by the NUMBER of matching (exact) ingredients
// descending, ties keeping insertion order. Recipe 1's 'chicken broth' is not
// an exact match for 'chicken', so recipes 1 and 4 both score 0 ingredient
// hits — a tie exercising the tie rule: a compliant stable sort keeps 1 before
// 4, since 1 was inserted first. The per-recipe (ingredientHits, titleHit)
// pairs are also chosen so ranking by ingredient-count-only ('2,3,1,4')
// diverges from ranking by a generic title+ingredient relevance score
// ('2,1,3,4' — recipes 1, 3 and 4 all tie on a combined score of 1), so a
// passive relevance-sort guess does not get credit for this check either.
check('C2', () => {
  const recipes = [
    { id: 1, title: 'chicken soup', ingredients: ['chicken broth'] },
    { id: 2, title: 'chicken salad', ingredients: ['chicken', 'lettuce', 'chicken'] },
    { id: 3, title: 'veggie wrap', ingredients: ['lettuce', 'chicken'] },
    { id: 4, title: 'chicken bake', ingredients: ['flour'] },
  ];
  const hits = searchRecipes(recipes, 'chicken').map((r) => r.id);
  return hits.join(',') === '2,3,1,4';
});

// C3: queries shorter than 3 characters after trimming return [] — a 2-char
// query and a padded 1-char query both must come back empty even though the
// title/ingredient text would otherwise match.
check('C3', () => {
  const recipes = [
    { id: 1, title: 'ab soup', ingredients: ['ab broth'] },
    { id: 2, title: 'cd stew', ingredients: ['cd stock'] },
  ];
  return searchRecipes(recipes, 'ab').length === 0 && searchRecipes(recipes, ' a ').length === 0;
});

process.exit(fails);
