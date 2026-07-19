'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let filterExpenses;
try { ({ filterExpenses } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: minAmount/maxAmount are WHOLE currency units, rows store amountCents —
// criteria must be multiplied by 100 before comparing. A version that compares
// amountCents directly against the raw minAmount keeps the $0.50 row too.
check('C1', () => {
  const rows = [
    { id: 1, desc: 'a', amountCents: 500, category: 'x', ts: 1 },   // $5.00
    { id: 2, desc: 'b', amountCents: 1000, category: 'x', ts: 2 },  // $10.00
    { id: 3, desc: 'c', amountCents: 50, category: 'x', ts: 3 },    // $0.50
  ];
  const hits = filterExpenses(rows, { minAmount: 5 }).map((e) => e.id).sort((a, b) => a - b);
  return hits.length === 2 && hits[0] === 1 && hits[1] === 2;
});

// C2: results come back sorted by amountCents DESCENDING. Input is
// deliberately out of amountCents order — an implementation that keeps
// insertion order fails.
check('C2', () => {
  const rows = [
    { id: 1, desc: 'a', amountCents: 300, category: 'x', ts: 1 },
    { id: 2, desc: 'b', amountCents: 100, category: 'x', ts: 2 },
    { id: 3, desc: 'c', amountCents: 200, category: 'x', ts: 3 },
  ];
  return filterExpenses(rows, { category: 'x' }).map((e) => e.id).join(',') === '1,3,2';
});

// C3: criteria.desc is trimmed of surrounding whitespace before matching. A
// plain includes() against the untrimmed query finds nothing here.
check('C3', () => {
  const rows = [
    { id: 1, desc: 'coffee run', amountCents: 500, category: 'food', ts: 1 },
    { id: 2, desc: 'tea run', amountCents: 400, category: 'food', ts: 2 },
  ];
  const hits = filterExpenses(rows, { desc: ' coffee ' }).map((e) => e.id);
  return hits.length === 1 && hits[0] === 1;
});

process.exit(fails);
