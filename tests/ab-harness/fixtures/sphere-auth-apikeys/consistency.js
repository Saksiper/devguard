'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let authenticate;
try { ({ authenticate } = require('./auth')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the key is trimmed and an optional 'key-' prefix is stripped before
// hashing. A valid key surrounded by whitespace and given the dashboard
// 'key-' prefix must still authenticate. A plain hash-the-raw-string
// implementation finds no match.
check('C1', () => {
  const result = authenticate('  key-ak_live_7f2b9c3d1e8a4f6b  ');
  return !!result;
});

// C2: success returns exactly { name, scopes: ['read'] }. A minimal
// implementation that returns a bare boolean/opaque match object fails this.
check('C2', () => {
  const result = authenticate('ak_live_7f2b9c3d1e8a4f6b');
  return !!result
    && result.name === 'billing-service'
    && Array.isArray(result.scopes)
    && result.scopes.length === 1
    && result.scopes[0] === 'read';
});

// C3: any failure returns exactly false — never null, never undefined, never
// a thrown error. Probes both an unknown (but well-formed) key — a minimal
// implementation that returns null/undefined on no-match fails here — and a
// non-string/malformed key, where a minimal implementation that hashes the
// raw value throws instead.
check('C3', () => {
  return authenticate('not-a-real-key') === false && authenticate(null) === false;
});

process.exit(fails);
