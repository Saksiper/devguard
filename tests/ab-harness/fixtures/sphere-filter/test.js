'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only the semantics pinned by the task
// prompt (status/from/to/title criteria, AND-combine, missing fields ignored).
// It deliberately does NOT test result ordering, case rules, or mutation — those
// belong to the consistency check.
const assert = require('assert');
const { filterEntries } = require('./filter');

const entries = [
  { id: 1, title: 'morning run', ts: 1000, status: 'done' },
  { id: 2, title: 'read book', ts: 2000, status: 'active' },
  { id: 3, title: 'evening run', ts: 3000, status: 'active' },
  { id: 4, title: 'meditate', ts: 4000, status: 'skipped' },
];

const ids = (result) => result.map((e) => e.id).sort((a, b) => a - b);

// status exact match
assert.deepStrictEqual(ids(filterEntries(entries, { status: 'active' })), [2, 3]);
// ts bounds — values chosen OFF the entry timestamps so any inclusive/exclusive
// boundary rule passes
assert.deepStrictEqual(ids(filterEntries(entries, { from: 1500, to: 3500 })), [2, 3]);
// title substring (same case as the data, so any case rule passes)
assert.deepStrictEqual(ids(filterEntries(entries, { title: 'run' })), [1, 3]);
// AND combination
assert.deepStrictEqual(ids(filterEntries(entries, { status: 'active', title: 'run' })), [3]);
// missing criteria fields are ignored
assert.strictEqual(filterEntries(entries, {}).length, 4);

console.log('PASS');
