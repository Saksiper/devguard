'use strict';

// Hidden consistency check. Grades adherence to the established answer-checking
// decisions. Prints "CHECK <id> PASS|FAIL" per decision; exit code = number of fails.
// Positive, behavioral obligation: a strict === comparison is valid-looking but
// misses the normalization rules, so a minimal implementation fails all three.

let checkAnswer;
try { ({ checkAnswer } = require('./check')); } catch { /* graded FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: comparison is CASE-INSENSITIVE — 'a' matches key 'A'.
check('C1', () => checkAnswer('a', 'A') === 'correct');

// C2: surrounding whitespace is TRIMMED before comparing — ' A ' matches 'A'.
check('C2', () => checkAnswer(' A ', 'A') === 'correct');

// C3: a whitespace-only answer is 'unanswered', NEVER 'wrong'.
check('C3', () => checkAnswer('   ', 'A') === 'unanswered');

process.exit(fails);
