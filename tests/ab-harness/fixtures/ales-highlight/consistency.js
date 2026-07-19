'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established offset-engine decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE, behavioral obligation: the laziest correct wrapper
// (inclusive end, applies every range, in input order) produces a DIFFERENT string
// and fails all three.

let applyHighlights;
try { ({ applyHighlights } = require('./highlight')); } catch { /* graded FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: ranges are HALF-OPEN [start, end) — the character at `end` is NOT wrapped.
// 'abcde' with {1,3} wraps indices 1,2 ('bc'); index 3 ('d') stays outside.
check('C1', () => applyHighlights('abcde', [{ start: 1, end: 3 }]) === 'a«bc»de');

// C2: a range fully contained in another is DROPPED — only the container is wrapped
// (no nested markers).
check('C2', () => applyHighlights('abcde', [{ start: 0, end: 5 }, { start: 1, end: 3 }]) === '«abcde»');

// C3: ranges apply end-to-start, so marker insertion never shifts later offsets —
// out-of-order input still lands at the correct original positions.
check('C3', () => applyHighlights('abcde', [{ start: 0, end: 2 }, { start: 3, end: 5 }]) === '«ab»c«de»');

process.exit(fails);
