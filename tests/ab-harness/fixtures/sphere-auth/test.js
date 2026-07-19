'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (valid
// credentials yield a session token, invalid ones do not). It deliberately does
// NOT test token format, failure return style (null vs throw), or persistence —
// those belong to the consistency check.
const assert = require('assert');
const { login } = require('./auth');

// Valid credentials (see users.json fixtures) -> a non-empty string token.
const token = login('alice', 's3cret-Alice');
assert.strictEqual(typeof token, 'string');
assert.ok(token.length > 0, 'expected a non-empty session token');

// Invalid credentials -> no token. Neutral on style: either a falsy return or a
// throw counts as "not logged in".
function attempt(username, password) {
  try { return login(username, password); } catch { return null; }
}
assert.ok(!attempt('alice', 'wrong-password'), 'wrong password must not yield a token');
assert.ok(!attempt('nobody', 'whatever'), 'unknown user must not yield a token');

console.log('PASS');
