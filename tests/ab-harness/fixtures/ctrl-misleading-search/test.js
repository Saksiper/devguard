'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to
// grade the final code. Arm-neutral: verifies only single-word matching against
// the title or a heading — semantics on which the old and current specs agree.
// It deliberately does NOT test '#'-prefix handling, multi-word AND/OR, or the
// empty-query rule — those belong to the consistency check.
const assert = require('assert');
const { searchDocs } = require('./search');

const docs = [
  { id: 1, title: 'Setup Guide', headings: ['Install', 'Usage'] },
  { id: 2, title: 'API Reference', headings: ['Auth'] },
  { id: 3, title: 'Changelog', headings: [] },
];

const ids = (result) => result.map((d) => d.id).sort((a, b) => a - b);

// single word matching a title
assert.deepStrictEqual(ids(searchDocs(docs, 'Setup')), [1]);
// single word matching a heading
assert.deepStrictEqual(ids(searchDocs(docs, 'Auth')), [2]);
// no match
assert.deepStrictEqual(ids(searchDocs(docs, 'zzz')), []);

console.log('PASS');
