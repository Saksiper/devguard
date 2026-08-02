'use strict';

// Hidden consistency check for a MISLEADING-note control task: the seeded note
// asserts the OLD decisions (overlap window, cancelled excluded, ascending sort),
// but the prompt supersedes them. These checks grade adherence to the CURRENT
// spec, so an implementation that obeys the stale note fails all three.
// Prints one "CHECK <id> PASS|FAIL" line per requirement; exit code = fails.

let filterEvents;
try { ({ filterEvents } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: the window matches by START only (from <= startTs < to). This event
// starts before the window but is still running when it opens — the OLD
// overlap rule wrongly includes it.
check('C1', () => {
  const events = [
    { id: 1, title: 'Ongoing Meeting', startTs: 500, endTs: 1500, cancelled: false },
  ];
  return filterEvents(events, { from: 1000, to: 2000 }).length === 0;
});

// C2: cancelled events are INCLUDED by default (the OLD rule excluded them).
check('C2', () => {
  const events = [
    { id: 1, title: 'Cancelled Meeting', startTs: 100, endTs: 200, cancelled: true },
  ];
  const hits = filterEvents(events, {}).map((e) => e.id);
  return hits.length === 1 && hits[0] === 1;
});

// C3: results come back sorted DESCENDING by startTs. Input is deliberately
// out of order — insertion order and the OLD ascending sort both fail.
check('C3', () => {
  const events = [
    { id: 1, title: 'C', startTs: 300, endTs: 400, cancelled: false },
    { id: 2, title: 'A', startTs: 100, endTs: 200, cancelled: false },
    { id: 3, title: 'B', startTs: 200, endTs: 250, cancelled: false },
  ];
  return filterEvents(events, {}).map((e) => e.id).join(',') === '1,3,2';
});

process.exit(fails);
