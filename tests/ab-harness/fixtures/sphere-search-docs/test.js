'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a query
// returns the docs that match it). Every query here is a plain word that appears
// in a title and in NO heading, so it deliberately does NOT exercise heading
// matching, the '#' heading-only prefix, or the empty-query guard — those belong
// to the consistency check.
const assert = require('assert');
const { searchDocs } = require('./search');

const docs = [
  { id: 1, title: 'Backup Strategy', headings: ['Schedule', 'Retention'] },
  { id: 2, title: 'Rollback Strategy', headings: ['Triggers', 'Steps'] },
  { id: 3, title: 'Deployment Pipeline', headings: ['Stages', 'Approvals'] },
];

const ids = (result) => result.map((d) => d.id).sort((a, b) => a - b);

// title substring, matches two docs, no heading contains the query
assert.deepStrictEqual(ids(searchDocs(docs, 'Strategy')), [1, 2]);
// title substring, single match
assert.deepStrictEqual(ids(searchDocs(docs, 'Deployment')), [3]);
// no match anywhere -> empty
assert.deepStrictEqual(searchDocs(docs, 'zzz-no-such-token'), []);

console.log('PASS');
