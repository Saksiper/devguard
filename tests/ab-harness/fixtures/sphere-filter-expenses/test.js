'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only the semantics pinned by the task
// prompt (category/desc criteria, AND-combine, missing fields ignored). It
// deliberately does NOT test minAmount/maxAmount (unit interpretations
// diverge), result ordering, or desc trimming — those belong to the
// consistency check.
const assert = require('assert');
const { filterExpenses } = require('./filter');

const rows = [
  { id: 1, desc: 'coffee run', amountCents: 350, category: 'food', ts: 1000 },
  { id: 2, desc: 'taxi ride', amountCents: 1200, category: 'transport', ts: 2000 },
  { id: 3, desc: 'coffee beans', amountCents: 900, category: 'food', ts: 3000 },
  { id: 4, desc: 'bus ticket', amountCents: 250, category: 'transport', ts: 4000 },
];

const ids = (result) => result.map((e) => e.id).sort((a, b) => a - b);

// category exact match
assert.deepStrictEqual(ids(filterExpenses(rows, { category: 'food' })), [1, 3]);
// desc substring (no surrounding whitespace, so any trim rule passes)
assert.deepStrictEqual(ids(filterExpenses(rows, { desc: 'coffee' })), [1, 3]);
// AND combination
assert.deepStrictEqual(ids(filterExpenses(rows, { category: 'food', desc: 'beans' })), [3]);
// missing criteria fields are ignored
assert.strictEqual(filterExpenses(rows, {}).length, 4);

console.log('PASS');
