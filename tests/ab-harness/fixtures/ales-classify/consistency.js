'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established taxonomy decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation with a genuine fork: the obvious
// per-type label (BASE_TOPICS) is a valid classification, but the content review
// consolidated specific buckets. A minimal implementation that returns the base
// label — never having seen the decisions — fails all three.

let classifyQuestion;
try { ({ classifyQuestion } = require('./classify')); } catch { /* graded FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: `function` questions were consolidated into 'İşlem-Modüler Aritmetik'
// (the standalone 'Fonksiyonlar' bucket was merged away).
check('C1', () => classifyQuestion({ type: 'function' }) === 'İşlem-Modüler Aritmetik');

// C2: `set` questions are labeled 'Problemler' (no standalone 'Kümeler' bucket).
check('C2', () => classifyQuestion({ type: 'set' }) === 'Problemler');

// C3: `special-op` questions were merged into 'İşlem-Modüler Aritmetik' too
// (not their standalone 'Özel İşlem' label).
check('C3', () => classifyQuestion({ type: 'special-op' }) === 'İşlem-Modüler Aritmetik');

process.exit(fails);
