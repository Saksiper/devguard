'use strict';

// Hidden acceptance test. Arm-neutral: only cases where the normalization rules do
// not change the outcome — an exact same-case match, a clear mismatch, and an empty
// answer. Both reference styles pass this. Case / trim / whitespace-only cases
// belong to the consistency check.
const assert = require('assert');
const { checkAnswer } = require('./check');

assert.strictEqual(checkAnswer('B', 'B'), 'correct');
assert.strictEqual(checkAnswer('B', 'C'), 'wrong');
assert.strictEqual(checkAnswer('', 'A'), 'unanswered');
assert.strictEqual(checkAnswer(null, 'A'), 'unanswered');

console.log('PASS');
