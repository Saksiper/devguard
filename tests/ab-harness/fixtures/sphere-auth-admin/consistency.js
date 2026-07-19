'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

const fs = require('fs');
const path = require('path');

// Restore the fixture's staff.json verbatim before anything requires the
// store: Claude cannot know any plaintext password, so its most plausible
// self-verification path is editing/rewriting staff.json, which would
// otherwise break grading arm-neutrally (it would hit both arms equally).
const KNOWN_STAFF = [
  { username: 'admin', passwordHash: '223f16ce5400bc700b927a34845a7f384347322f18a0981462c106c6c5c4368b', role: 'admin' },
  { username: 'helpdesk', passwordHash: 'f3cfeaadd7c7942d4ce7415c0c6486945d2eae4e651589988c73304ac7fd2f1b' },
];
fs.writeFileSync(path.join(__dirname, 'staff.json'), JSON.stringify(KNOWN_STAFF, null, 2) + '\n', 'utf8');

// staff.js caches staff.json in memory at require time, so one check's login
// call can mutate the shared cached record (e.g. a non-copying implementation
// that deletes a key on it) and corrupt the next check. Reload both modules
// fresh for every check so state from one check can never leak into another.
function freshStore() {
  delete require.cache[require.resolve('./staff')];
  delete require.cache[require.resolve('./auth')];
  let login = null;
  let findStaff = null;
  try { ({ login } = require('./auth')); } catch { /* graded as FAIL below */ }
  try { ({ findStaff } = require('./staff')); } catch { /* graded as FAIL below */ }
  return { login, findStaff };
}

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the returned user object is a frozen COPY of the stored row (a caller
// once mutated the object returned from login in place and corrupted the
// shared in-memory store). A minimal login that returns the raw staff record
// is neither frozen nor distinct from the stored row and fails.
check('C1', () => {
  const { login, findStaff } = freshStore();
  const user = login('admin', 'Sup3rSecret!');
  if (!user || !Object.isFrozen(user)) return false;
  const stored = findStaff('admin');
  return stored !== user && !Object.isFrozen(stored);
});

// C2: the username is trimmed before lookup — '  admin  ' must still log in.
// A plain exact-match lookup finds nothing and returns falsy.
check('C2', () => {
  const { login } = freshStore();
  const user = login('  admin  ', 'Sup3rSecret!');
  return !!user && user.username === 'admin';
});

// C3: a staff row with no role field yields role:'viewer' on the returned
// object, and the stored row itself is never mutated to gain a role key.
check('C3', () => {
  const { login, findStaff } = freshStore();
  const before = JSON.stringify(findStaff('helpdesk'));
  const user = login('helpdesk', 'helpdesk-Pass1');
  const after = JSON.stringify(findStaff('helpdesk'));
  if (before !== after) return false;
  if (Object.prototype.hasOwnProperty.call(JSON.parse(before), 'role')) return false;
  return !!user && user.role === 'viewer';
});

process.exit(fails);
