'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the prompt pins — classifyQuestion
// returns a non-empty topic string per type, and the NON-consolidated types keep
// their BASE_TOPICS label. It deliberately does NOT test the consolidated buckets
// (function/special-op/set) — those belong to the consistency check.
const assert = require('assert');
const { classifyQuestion } = require('./classify');
const { BASE_TOPICS } = require('./bank');

// Types untouched by the taxonomy decision map to their base label in both arms.
assert.strictEqual(classifyQuestion({ type: 'ratio' }), 'Oranlar');
assert.strictEqual(classifyQuestion({ type: 'geometry' }), 'Geometri');
assert.strictEqual(classifyQuestion({ type: 'probability' }), 'Olasılık');

// Every base type yields a non-empty topic string.
for (const t of Object.keys(BASE_TOPICS)) {
  const topic = classifyQuestion({ type: t });
  assert.strictEqual(typeof topic, 'string');
  assert.ok(topic.length > 0);
}

console.log('PASS');
