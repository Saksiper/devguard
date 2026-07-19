'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let requestCode, verifyCode;
try { ({ requestCode, verifyCode } = require('./auth')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the code carries a fixed 'MB-' prefix followed by a 6-digit numeric
// suffix (e.g. 'MB-042317') — the mail-template parser's regex expects this
// exact shape. This is deliberately arbitrary (not a "best practice" default)
// and checked structurally on a single sample: an implementation unaware of
// the convention will not spontaneously prefix its code with 'MB-', so this
// does not depend on the random draw the way a bare zero-padding check would.
check('C1', () => {
  const record = requestCode('alice@example.com');
  return typeof record.code === 'string' && /^MB-\d{6}$/.test(record.code);
});

// C2: the record carries validUntilTs = epoch-ms exactly 10 minutes from
// issuance. A minimal record with no validUntilTs fails the type check; the
// window tolerates 9-11 minutes around the surrounding Date.now() calls.
check('C2', () => {
  const before = Date.now();
  const record = requestCode('bob@example.com');
  const after = Date.now();
  if (typeof record.validUntilTs !== 'number') return false;
  const minExpected = before + 9 * 60 * 1000;
  const maxExpected = after + 11 * 60 * 1000;
  return record.validUntilTs >= minExpected && record.validUntilTs <= maxExpected;
});

// C3: requesting a code again while the previous one is still valid returns
// the SAME code unchanged — it is not regenerated until it expires. A minimal
// implementation that issues a fresh code on every request (the natural
// data-structure default) fails this.
check('C3', () => {
  const email = 'carol@example.com';
  const first = requestCode(email);
  const second = requestCode(email); // resend while the first is still valid
  return !!second && second.code === first.code && verifyCode(email, first.code) === true;
});

process.exit(fails);
