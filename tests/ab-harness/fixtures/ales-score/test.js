'use strict';

// Hidden acceptance test. Arm-neutral: only NO-WRONG cases, where the net score
// equals the plain correct count regardless of the penalty / floor / blank rules
// (those are the consistency check). Both reference styles pass this.
const assert = require('assert');
const { scoreExam } = require('./score');

// All correct.
assert.strictEqual(scoreExam(['A', 'B', 'C'], ['A', 'B', 'C']), 3);
// Some correct, some blank, NO wrong answers.
assert.strictEqual(scoreExam(['A', 'B', '', ''], ['A', 'B', 'C', 'D']), 2);
// Nothing answered.
assert.strictEqual(scoreExam(['', '', ''], ['A', 'B', 'C']), 0);

console.log('PASS');
