'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a valid
// key yields a truthy result, an unknown key does not). It deliberately does NOT
// test the success shape, the failure value, or trimming/prefix handling — those
// belong to the consistency check.
const assert = require('assert');
const { authenticate } = require('./auth');

// Valid key (see keys.json fixtures), passed exactly as stored -> truthy result.
const result = authenticate('ak_live_7f2b9c3d1e8a4f6b');
assert.ok(result, 'expected a truthy result for a valid key');

// Unknown key -> falsy result or throw. Neutral on style.
function attempt(key) {
  try { return authenticate(key); } catch { return null; }
}
assert.ok(!attempt('not-a-real-key'), 'unknown key must not authenticate');

console.log('PASS');
