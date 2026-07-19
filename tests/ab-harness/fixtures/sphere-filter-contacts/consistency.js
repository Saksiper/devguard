'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let filterContacts;
try { ({ filterContacts } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the domain criterion matches the part after '@' EXACTLY, AND a leading
// '@' in the criterion value is normalized away first — 'gmail.com' and
// '@gmail.com' must both match the same contacts. 'mail.com' must NOT match
// 'gmail.com' (rules out suffix/substring checks); a plain, decision-blind
// exact-match (e.g. email.split('@')[1] === criteria.domain, with no '@'
// stripping) gets the first assert right but fails the second, since it
// never matches when the criterion itself carries a leading '@'.
check('C1', () => {
  const contacts = [
    { id: 1, name: 'Eve', email: 'eve@gmail.com', favorite: false },
    { id: 2, name: 'Frank', email: 'frank@mail.com', favorite: false },
  ];
  const exact = filterContacts(contacts, { domain: 'mail.com' }).map((c) => c.id);
  const normalized = filterContacts(contacts, { domain: '@mail.com' }).map((c) => c.id);
  return (
    exact.length === 1 && exact[0] === 2 &&
    normalized.length === 1 && normalized[0] === 2
  );
});

// C2: favorite contacts are ALWAYS moved to the front of the results,
// regardless of other ordering. Input is deliberately not favorite-first —
// an implementation that just filters in place keeps the favorite buried.
check('C2', () => {
  const contacts = [
    { id: 1, name: 'a', email: 'a@x.com', favorite: false },
    { id: 2, name: 'b', email: 'b@x.com', favorite: true },
    { id: 3, name: 'c', email: 'c@x.com', favorite: false },
  ];
  const hits = filterContacts(contacts, { domain: 'x.com' }).map((c) => c.id);
  return hits.length === 3 && hits[0] === 2;
});

// C3: an empty criteria object ({}) returns [] — this app shows nothing
// until a filter is applied. A default that treats {} as "no constraints"
// returns every contact instead.
check('C3', () => {
  const contacts = [{ id: 1, name: 'a', email: 'a@x.com', favorite: false }];
  const hits = filterContacts(contacts, {});
  return Array.isArray(hits) && hits.length === 0;
});

process.exit(fails);
