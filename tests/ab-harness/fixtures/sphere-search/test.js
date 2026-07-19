'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a title
// substring query returns the matching notes). It deliberately does NOT test
// which other fields match, result ordering, case rules, or empty-query
// semantics — those belong to the consistency check.
const assert = require('assert');
const { searchNotes } = require('./search');

const notes = [
  { id: 1, title: 'groceries list', body: 'milk and eggs', ts: 1000 },
  { id: 2, title: 'meeting agenda', body: 'quarterly outlook', ts: 2000 },
  { id: 3, title: 'reading list', body: 'sci-fi picks', ts: 3000 },
];

const ids = (result) => result.map((n) => n.id).sort((a, b) => a - b);

// title substring (same case as the data, so any case rule passes)
assert.deepStrictEqual(ids(searchNotes(notes, 'list')), [1, 3]);
assert.deepStrictEqual(ids(searchNotes(notes, 'agenda')), [2]);
// no match anywhere -> empty
assert.deepStrictEqual(searchNotes(notes, 'zzz-no-such-token'), []);

console.log('PASS');
