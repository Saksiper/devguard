'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (valid
// credentials yield a session object with a truthy token, and that token is
// immediately valid; invalid credentials yield a falsy result). It deliberately
// does NOT test token shape, expiresAt, or repeat-login behavior — those belong
// to the consistency check.
const assert = require('assert');
const { login, isValid } = require('./auth');

// Valid credentials (see accounts.json fixtures) -> a session with a truthy token.
const session = login('alice', 'Wonderland-42');
assert.ok(session && session.token, 'expected a session object with a truthy token');
assert.strictEqual(isValid(session.token), true, 'a freshly issued token must be valid');

// Wrong password -> falsy.
assert.ok(!login('alice', 'wrong-password'), 'wrong password must not yield a session');

// Unknown user -> falsy.
assert.ok(!login('nobody', 'whatever'), 'unknown user must not yield a session');

console.log('PASS');
