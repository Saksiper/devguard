'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that
// never saw the decisions fails all three.

let filterLogs;
try { ({ filterLogs } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: level is a MINIMUM severity (debug < info < warn < error) — filtering
// by 'warn' must also return 'error' lines. A plain exact-match check only
// returns the 'warn' line.
check('C1', () => {
  const lines = [
    { id: 1, level: 'debug', msg: 'x', ts: 100 },
    { id: 2, level: 'info', msg: 'x', ts: 200 },
    { id: 3, level: 'warn', msg: 'x', ts: 300 },
    { id: 4, level: 'error', msg: 'x', ts: 400 },
  ];
  const hits = filterLogs(lines, { level: 'warn' }).map((l) => l.id).sort((a, b) => a - b);
  return hits.length === 2 && hits[0] === 3 && hits[1] === 4;
});

// C2: the level criterion is case-insensitive — 'WARN' must match a stored
// 'warn' line. A case-sensitive comparison matches nothing.
check('C2', () => {
  const lines = [
    { id: 1, level: 'warn', msg: 'x', ts: 100 },
    { id: 2, level: 'debug', msg: 'x', ts: 200 },
  ];
  const hits = filterLogs(lines, { level: 'WARN' }).map((l) => l.id);
  return hits.length === 1 && hits[0] === 1;
});

// C3: output is capped at the 100 most recent matching lines by ts, kept in
// ascending-ts order. An unbounded implementation returns all 150.
check('C3', () => {
  const lines = [];
  for (let i = 1; i <= 150; i++) {
    lines.push({ id: i, level: 'info', msg: `line ${i}`, ts: i * 1000 });
  }
  const result = filterLogs(lines, {});
  if (result.length !== 100) return false;
  for (let i = 0; i < result.length; i++) {
    if (result[i].ts !== (51 + i) * 1000) return false;
  }
  return true;
});

process.exit(fails);
