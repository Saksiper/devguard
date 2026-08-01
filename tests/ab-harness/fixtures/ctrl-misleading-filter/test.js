'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to
// grade the final code. Arm-neutral: verifies only the semantics pinned by
// the task prompt (from/to window, title substring, AND-combine, missing
// fields ignored). It deliberately does NOT test overlap-vs-starts-inside,
// cancelled-row handling, or result ordering — those belong to the
// consistency check.
const assert = require('assert');
const { filterEvents } = require('./filter');

const events = [
  // cancelled, and lies before every window used below, so it is excluded by
  // the window itself regardless of how (or whether) cancelled is handled
  { id: 1, title: 'Old Sync', startTs: 100, endTs: 300, cancelled: true },
  { id: 2, title: 'Team Standup', startTs: 1000, endTs: 1500, cancelled: false },
  { id: 3, title: 'Design Review', startTs: 5000, endTs: 5500, cancelled: false },
  { id: 4, title: 'Client Call', startTs: 9000, endTs: 9500, cancelled: false },
];

const ids = (result) => result.map((e) => e.id).sort((a, b) => a - b);

// window — events lie FULLY inside [from, to], so overlap semantics and a
// starts-inside-only rule agree either way
assert.deepStrictEqual(ids(filterEvents(events, { from: 500, to: 6000 })), [2, 3]);
// title substring
assert.deepStrictEqual(ids(filterEvents(events, { title: 'Call' })), [4]);
// AND combination
assert.deepStrictEqual(ids(filterEvents(events, { from: 500, to: 6000, title: 'Review' })), [3]);
// missing 'title' is ignored — a different window alone still applies
assert.deepStrictEqual(ids(filterEvents(events, { from: 4000, to: 9600 })), [3, 4]);

console.log('PASS');
