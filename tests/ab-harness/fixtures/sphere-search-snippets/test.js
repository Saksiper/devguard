'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a query
// returns the snippets whose title or code match it). It deliberately does NOT
// test 'lang:' filtering, case rules, or result ordering — those belong to the
// consistency check.
const assert = require('assert');
const { searchSnippets } = require('./search');

const snippets = [
  { id: 1, title: 'Binary Search', code: 'function bsearch(arr, target) { return -1; }', lang: 'js' },
  { id: 2, title: 'Linked List', code: 'class Node { constructor(v) { this.v = v; } }', lang: 'js' },
  { id: 3, title: 'Hash Table', code: 'const map = {};', lang: 'python' },
  { id: 4, title: 'Binary Tree', code: 'class TreeNode { constructor(v) { this.v = v; } }', lang: 'python' },
];

const ids = (result) => result.map((s) => s.id).sort((a, b) => a - b);

// title match (same case as the data, so any case rule passes; the word does
// not appear in any code field, so which fields get searched doesn't matter)
assert.deepStrictEqual(ids(searchSnippets(snippets, 'Binary')), [1, 4]);
// single-hit title match
assert.deepStrictEqual(ids(searchSnippets(snippets, 'Hash')), [3]);
// no match anywhere -> empty
assert.deepStrictEqual(searchSnippets(snippets, 'zzz-no-such-token'), []);

console.log('PASS');
