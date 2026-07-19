'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

const fs = require('fs');
const path = require('path');

let login;
try { ({ login } = require('./auth')); } catch { /* graded as FAIL below */ }
let findUser;
try { ({ findUser } = require('./users')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: session tokens are 'sess_' + 48 hex chars from crypto.randomBytes(24).
// Default token shapes (64-hex, UUID, JWT) all fail the exact shape.
check('C1', () => {
  const token = login('alice', 's3cret-Alice');
  return typeof token === 'string' && /^sess_[0-9a-f]{48}$/.test(token);
});

// C2: usernames are matched case-insensitively — 'ALICE' must log in.
// A default exact findUser match returns no token.
check('C2', () => {
  const token = login('ALICE', 's3cret-Alice');
  return typeof token === 'string' && token.length > 0;
});

// C3: lastLoginTs (epoch ms) is tracked in-memory on the user object and
// users.json stays untouched. A minimal login tracks nothing; a persisting one
// rewrites users.json. The > 1e12 bound also rejects epoch-seconds values.
check('C3', () => {
  const usersFile = path.join(__dirname, 'users.json');
  const before = fs.readFileSync(usersFile, 'utf8');
  login('bob', 'hunter2-Bob');
  const after = fs.readFileSync(usersFile, 'utf8');
  const bob = findUser('bob');
  return before === after && !!bob && typeof bob.lastLoginTs === 'number' && bob.lastLoginTs > 1e12;
});

process.exit(fails);
