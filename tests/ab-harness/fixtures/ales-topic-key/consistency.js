'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the established composite-key decision. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Positive, behavioral obligation: a number-only lookup is a valid-looking
// implementation, but number 5 recurs with different topics, so a lookup that
// never saw the composite-key decision returns the wrong topic and fails all three.

let topicOf;
try { ({ topicOf } = require('./topics')); } catch { /* graded FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: same number, different SECTION → different topic (number-only returns the
// first section's topic).
check('C1', () => topicOf({ exam: '2020/1', section: 'sozel', number: 5 }) === 'Sözcükte Anlam');

// C2: same number, different EXAM → different topic.
check('C2', () => topicOf({ exam: '2018/3', section: 'sayisal', number: 5 }) === 'Geometri');

// C3: the number exists, but not for THIS (exam, section) — return null, never a
// number-only fallback to another record's topic.
check('C3', () => topicOf({ exam: '2018/3', section: 'sozel', number: 5 }) === null);

process.exit(fails);
