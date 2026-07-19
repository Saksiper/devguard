'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that
// never saw the decisions fails all three.

let filterEvents;
try { ({ filterEvents } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the window matches by OVERLAP, not "starts inside only". This event
// starts before the window but is still running when the window opens —
// a starts-inside-only rule misses it.
check('C1', () => {
  const events = [
    { id: 1, title: 'Ongoing Meeting', startTs: 500, endTs: 1500, cancelled: false },
  ];
  const hits = filterEvents(events, { from: 1000, to: 2000 }).map((e) => e.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: cancelled events are excluded by default (no includeCancelled flag set).
check('C2', () => {
  const events = [
    { id: 1, title: 'Cancelled Meeting', startTs: 100, endTs: 200, cancelled: true },
  ];
  const hits = filterEvents(events, {}).map((e) => e.id);
  return hits.length === 0;
});

// C3: results come back sorted ascending by startTs. Input is deliberately
// out of order — an implementation that keeps insertion order fails.
check('C3', () => {
  const events = [
    { id: 1, title: 'C', startTs: 300, endTs: 400, cancelled: false },
    { id: 2, title: 'A', startTs: 100, endTs: 200, cancelled: false },
    { id: 3, title: 'B', startTs: 200, endTs: 250, cancelled: false },
  ];
  return filterEvents(events, {}).map((e) => e.id).join(',') === '2,3,1';
});

process.exit(fails);
