'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let filterTodos;
try { ({ filterTodos } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: todos with due === null are ALWAYS included when dueBefore is set.
// Two bounds are checked: a naive falsy-guard on t.due (treating "no due
// date" as "not before anything") excludes the null row under a positive
// bound, and a guard-free coercion impl (`t.due >= dueBefore` with no null
// check at all) accidentally includes the null row under a positive bound
// via ToNumber(null)=0 but excludes it under a negative bound (0 >= -1 is
// true) — only deliberate null-handling passes both.
check('C1', () => {
  const todos = [
    { id: 1, title: 'a', done: false, priority: 1, due: null },
    { id: 2, title: 'b', done: false, priority: 1, due: 5000 },
  ];
  const hits1 = filterTodos(todos, { dueBefore: 1000 }).map((t) => t.id);
  if (!(hits1.length === 1 && hits1[0] === 1)) return false;
  const hits2 = filterTodos(todos, { dueBefore: -1 }).map((t) => t.id);
  return hits2.length === 1 && hits2[0] === 1;
});

// C2: the title criterion is a PREFIX match, not substring, not exact
// equality, and not "match nothing". 'lk' is a substring of 'milk' but not a
// prefix of it or of 'lock' — a substring implementation wrongly matches
// 'milk'. 'lo' IS a true prefix of 'lock' — an exact-equality or
// match-nothing implementation wrongly matches nothing.
check('C2', () => {
  const todos = [
    { id: 1, title: 'milk', done: false, priority: 1, due: null },
    { id: 2, title: 'lock', done: false, priority: 1, due: null },
  ];
  const negHits = filterTodos(todos, { title: 'lk' }).map((t) => t.id);
  if (negHits.length !== 0) return false;
  const posHits = filterTodos(todos, { title: 'lo' }).map((t) => t.id);
  return posHits.length === 1 && posHits[0] === 2;
});

// C3: not-done todos first, then done todos, stable within each group. Input
// is deliberately interleaved with ids out of order relative to id so a
// no-op / original-order implementation AND a (done, id)-sort implementation
// both fail.
check('C3', () => {
  const todos = [
    { id: 9, title: 'a', done: true, priority: 1, due: null },
    { id: 2, title: 'b', done: false, priority: 1, due: null },
    { id: 7, title: 'c', done: true, priority: 1, due: null },
    { id: 1, title: 'd', done: false, priority: 1, due: null },
  ];
  const order = filterTodos(todos, {}).map((t) => t.id).join(',');
  return order === '2,1,9,7';
});

process.exit(fails);
