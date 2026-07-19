'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a known
// email gets a code that verifies, a wrong code is rejected, an unknown email
// gets no record). It deliberately does NOT test code shape, expiry, or
// re-request behavior — those belong to the consistency check.
const assert = require('assert');
const { requestCode, verifyCode } = require('./auth');

// Known email (see members.json fixture) -> a truthy record containing the code.
const record = requestCode('alice@example.com');
assert.ok(record, 'expected a truthy record for a known email');
assert.ok(record.code !== undefined && record.code !== null, 'expected the record to contain a code');
assert.strictEqual(verifyCode('alice@example.com', record.code), true);

// Wrong code -> false. Neutral: any implementation must reject a code that was
// never issued.
assert.strictEqual(verifyCode('alice@example.com', 'not-the-code'), false);

// Unknown email -> falsy record, and no code should verify for it.
assert.ok(!requestCode('nobody@example.com'), 'expected a falsy result for an unknown email');
assert.strictEqual(verifyCode('nobody@example.com', '000000'), false);

console.log('PASS');
