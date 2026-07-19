'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let login;
let isValid;
try { ({ login, isValid } = require('./auth')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: token is 'tk.' followed by exactly 32 lowercase alphanumeric characters.
// A default UUID/hex-without-prefix token fails the exact shape.
check('C1', () => {
  const session = login('alice', 'Wonderland-42');
  return !!session && /^tk\.[a-z0-9]{32}$/.test(session.token);
});

// C2: expiresAt is exactly 30 minutes after issuance (29-31 minute window).
// A default 1h/24h expiry falls well outside the window.
check('C2', () => {
  const before = Date.now();
  const session = login('bob', 'Builder-99');
  if (!session) return false;
  const diffMin = (session.expiresAt - before) / 60000;
  return diffMin > 29 && diffMin < 31;
});

// C3: logging in again as the same user invalidates the previous token
// (single active session per account). A default implementation that never
// revokes old tokens leaves the first token valid after the second login.
check('C3', () => {
  const first = login('carol', 'Danger-07');
  const second = login('carol', 'Danger-07');
  if (!first || !second) return false;
  return isValid(first.token) === false && isValid(second.token) === true;
});

process.exit(fails);
