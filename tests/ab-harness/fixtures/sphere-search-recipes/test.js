'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a query
// returns the recipes whose title matches it). Every query here is >=3 chars and
// matches titles only (no ingredient text contains the query), so it deliberately
// does NOT exercise ingredient matching, result ordering, or the short-query
// guard — those belong to the consistency check.
const assert = require('assert');
const { searchRecipes } = require('./search');

const recipes = [
  { id: 1, title: 'Pancake Stack', ingredients: ['flour', 'milk', 'egg'] },
  { id: 2, title: 'Veggie Omelette', ingredients: ['egg', 'cheese', 'pepper'] },
  { id: 3, title: 'Pasta Bake', ingredients: ['pasta', 'cheese', 'tomato'] },
];

const ids = (result) => result.map((r) => r.id).sort((a, b) => a - b);

// title substring, matches two recipes, no ingredient contains the query
assert.deepStrictEqual(ids(searchRecipes(recipes, 'ake')), [1, 3]);
// title substring, single match
assert.deepStrictEqual(ids(searchRecipes(recipes, 'Omelette')), [2]);
// no match anywhere -> empty
assert.deepStrictEqual(searchRecipes(recipes, 'zzz-no-such-token'), []);

console.log('PASS');
