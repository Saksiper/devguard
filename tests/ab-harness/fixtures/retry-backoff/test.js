'use strict';

// Hidden acceptance test. Copied in only to grade the final code.
const assert = require('assert');
const { retry } = require('./retry');

// Succeeds on the 3rd attempt; maxRetries=3 must allow exactly 3 attempts.
let attempts = 0;
const result = retry(() => {
  attempts++;
  if (attempts < 3) throw new Error('transient');
  return 'ok';
}, 3);
assert.strictEqual(result, 'ok', `expected 'ok' after 3 attempts, got ${result}`);
assert.strictEqual(attempts, 3, `expected exactly 3 attempts (maxRetries total), got ${attempts}`);

// When all attempts fail, the last error propagates.
let calls = 0;
let threw = null;
try {
  retry(() => { calls++; throw new Error('always ' + calls); }, 2);
} catch (e) { threw = e; }
assert.ok(threw && /always 2/.test(threw.message), `expected last error after 2 attempts, got ${threw && threw.message}`);

console.log('PASS');
