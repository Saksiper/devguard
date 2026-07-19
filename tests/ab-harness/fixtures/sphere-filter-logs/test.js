'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to
// grade the final code. Arm-neutral: verifies only the semantics pinned by
// the task prompt (level/since/until/msg criteria, AND-combine, missing
// fields ignored). Level checks use 'error' only (the top severity, where an
// exact-match rule and a minimum-severity rule agree), all level values are
// lowercase, the row count stays under the 100-line cap, and the since/until
// bounds fall between (not on) row timestamps. It deliberately does NOT test
// result ordering, level-threshold semantics, case rules, or the cap — those
// belong to the consistency check.
const assert = require('assert');
const { filterLogs } = require('./filter');

const lines = [
  { id: 1, level: 'debug', msg: 'starting up', ts: 1000 },
  { id: 2, level: 'info', msg: 'listening on port', ts: 2000 },
  { id: 3, level: 'error', msg: 'connection refused', ts: 3000 },
  { id: 4, level: 'warn', msg: 'slow query', ts: 4000 },
];

const ids = (result) => result.map((l) => l.id).sort((a, b) => a - b);

// level match (top severity — exact-match and minimum-severity agree here)
assert.deepStrictEqual(ids(filterLogs(lines, { level: 'error' })), [3]);
// ts bounds — values chosen OFF the row timestamps so any inclusive/exclusive
// boundary rule passes
assert.deepStrictEqual(ids(filterLogs(lines, { since: 1500, until: 3500 })), [2, 3]);
// msg substring
assert.deepStrictEqual(ids(filterLogs(lines, { msg: 'query' })), [4]);
// AND combination
assert.deepStrictEqual(ids(filterLogs(lines, { level: 'error', msg: 'refused' })), [3]);
// missing criteria fields are ignored
assert.strictEqual(filterLogs(lines, {}).length, 4);

console.log('PASS');
