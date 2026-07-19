'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: uses only question numbers that are UNIQUE in the
// sheet (so a number-only lookup and a composite lookup resolve identically) plus
// a number absent from every record. The collision cases — where number-only and
// composite disagree — belong to the consistency check.
const assert = require('assert');
const { topicOf } = require('./topics');

// Unique numbers: 12 and 9 each appear in exactly one record.
assert.strictEqual(topicOf({ exam: '2020/1', section: 'sayisal', number: 12 }), 'Problemler');
assert.strictEqual(topicOf({ exam: '2018/3', section: 'sozel', number: 9 }), 'Paragraf');

// A number that appears in NO record → null in both arms.
assert.strictEqual(topicOf({ exam: '2020/1', section: 'sayisal', number: 99 }), null);

console.log('PASS');
