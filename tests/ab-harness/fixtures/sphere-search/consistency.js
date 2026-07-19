'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let searchNotes;
try { ({ searchNotes } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: matching is case-insensitive — 'grocery' must match 'Grocery List'.
check('C1', () => {
  const notes = [
    { id: 1, title: 'Grocery List', body: '', ts: 1 },
    { id: 2, title: 'meeting agenda', body: '', ts: 2 },
  ];
  const hits = searchNotes(notes, 'grocery').map((n) => n.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: the query is split on whitespace and EVERY word must appear in the title
// (order/adjacency not required). Plain adjacent-substring matching finds nothing.
check('C2', () => {
  const notes = [
    { id: 1, title: 'the brown quick fox', body: '', ts: 1 },
    { id: 2, title: 'quick start guide', body: '', ts: 2 },
  ];
  const hits = searchNotes(notes, 'quick brown').map((n) => n.id);
  return hits.length === 1 && hits[0] === 1;
});

// C3: an empty or whitespace-only query returns [], not all notes (a plain
// includes('') matches everything).
check('C3', () => {
  const notes = [
    { id: 1, title: 'a', body: '', ts: 1 },
    { id: 2, title: 'b', body: '', ts: 2 },
  ];
  return searchNotes(notes, '').length === 0 && searchNotes(notes, '   ').length === 0;
});

process.exit(fails);
