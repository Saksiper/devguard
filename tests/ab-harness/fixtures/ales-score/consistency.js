'use strict';

// Hidden consistency check. Grades adherence to the established negative-marking
// decision. Prints "CHECK <id> PASS|FAIL" per decision; exit code = number of fails.
// Positive, behavioral obligation: the obvious score (count of correct answers) is
// valid-looking but wrong for this exam, so a minimal implementation that never saw
// the decision fails all three.

let scoreExam;
try { ({ scoreExam } = require('./score')); } catch { /* graded FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: negative marking — every 4 wrong answers cancel 1 correct. 5 correct, 4 wrong
// → 5 − 4/4 = 4 (a plain correct-count would say 5).
check('C1', () => scoreExam(
  ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'],
  ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A']) === 4);

// C2: blank/unanswered questions are EXEMPT from the penalty. 3 correct, 4 wrong,
// 5 blank → 3 − 4/4 = 2 (blanks must not add to the wrong count).
check('C2', () => scoreExam(
  ['A', 'A', 'A', 'B', 'B', 'B', 'B', '', '', '', '', ''],
  ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A']) === 2);

// C3: the net score is floored at 0, never negative. 1 correct, 12 wrong
// → 1 − 12/4 = −2 → 0.
check('C3', () => scoreExam(
  ['A', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B'],
  ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A']) === 0);

process.exit(fails);
