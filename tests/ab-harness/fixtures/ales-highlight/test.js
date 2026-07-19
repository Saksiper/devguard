'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the prompt pins — a single
// range gets wrapped, no source characters are lost, and empty ranges leave the
// text unchanged. Inputs are chosen so BOTH the half-open and inclusive-end
// conventions pass (it never asserts the exact wrapped span); the boundary/overlap/
// ordering rules belong to the consistency check.
const assert = require('assert');
const { applyHighlights } = require('./highlight');

const text = 'hello world';

// A single range: markers are added and every original character survives.
const r1 = applyHighlights(text, [{ start: 0, end: 5 }]);
assert.strictEqual(r1.replace(/[«»]/g, ''), text, 'no source characters lost');
assert.ok(r1.includes('«') && r1.includes('»'), 'range is wrapped');
assert.strictEqual((r1.match(/«/g) || []).length, 1, 'exactly one open marker');
assert.strictEqual((r1.match(/»/g) || []).length, 1, 'exactly one close marker');

// No ranges: text is returned unchanged.
assert.strictEqual(applyHighlights(text, []), text);

console.log('PASS');
