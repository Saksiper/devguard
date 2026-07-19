'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three (a prohibition-style check would pass
// trivially on minimal code — verified live in the haiku smoke run).

let filterEntries;
try { ({ filterEntries } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: title matching is case-insensitive — 'run' must match 'Morning Run'.
// A plain case-sensitive includes() finds nothing.
check('C1', () => {
  const entries = [
    { id: 1, title: 'Morning Run', ts: 1, status: 'active' },
    { id: 2, title: 'read book', ts: 2, status: 'active' },
  ];
  const hits = filterEntries(entries, { title: 'run' }).map((e) => e.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: results come back sorted ascending by ts. Input is deliberately out of
// ts order — an implementation that keeps insertion order fails.
check('C2', () => {
  const entries = [
    { id: 1, title: 'b', ts: 300, status: 'active' },
    { id: 2, title: 'a', ts: 100, status: 'active' },
    { id: 3, title: 'c', ts: 200, status: 'active' },
  ];
  return filterEntries(entries, { status: 'active' }).map((e) => e.id).join(',') === '2,3,1';
});

// C3: bounds are half-open [from, to) — an entry exactly at 'to' is excluded,
// 'from' stays inclusive. A default inclusive <= check keeps the boundary entry.
check('C3', () => {
  const entries = [
    { id: 1, title: 'a', ts: 100, status: 'active' },
    { id: 2, title: 'b', ts: 200, status: 'active' },
    { id: 3, title: 'c', ts: 300, status: 'active' },
  ];
  const hits = filterEntries(entries, { from: 100, to: 300 }).map((e) => e.id);
  return hits.length === 2 && hits.includes(1) && hits.includes(2) && !hits.includes(3);
});

process.exit(fails);
