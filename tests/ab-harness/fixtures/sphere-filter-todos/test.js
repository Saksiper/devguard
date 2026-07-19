'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to
// grade the final code. Arm-neutral: verifies only the semantics pinned by the
// task prompt (done/dueBefore/title criteria, AND-combine, missing fields
// ignored). It deliberately does NOT test null-due handling, title match
// style (prefix vs substring), or result ordering — those belong to the
// consistency check.
const assert = require('assert');
const { filterTodos } = require('./filter');

const todos = [
  { id: 1, title: 'buy milk', done: false, priority: 2, due: 1000 },
  { id: 2, title: 'write report', done: true, priority: 1, due: 2000 },
  { id: 3, title: 'buy bread', done: false, priority: 3, due: 3000 },
  { id: 4, title: 'call mom', done: true, priority: 2, due: 4000 },
  { id: 5, title: 'buy stamps', done: true, priority: 1, due: 5000 },
];

const ids = (result) => result.map((t) => t.id).sort((a, b) => a - b);

// done exact match (single done-state group, so any ordering rule passes)
assert.deepStrictEqual(ids(filterTodos(todos, { done: false })), [1, 3]);
// dueBefore — no null-due rows present, so any null-handling rule passes
assert.deepStrictEqual(ids(filterTodos(todos, { dueBefore: 2500 })), [1, 2]);
// title — 'buy' is a true PREFIX of every matched title, so prefix and
// substring matching rules agree
assert.deepStrictEqual(ids(filterTodos(todos, { title: 'buy' })), [1, 3, 5]);
// AND combination
assert.deepStrictEqual(ids(filterTodos(todos, { title: 'buy', done: false })), [1, 3]);
// missing criteria fields are ignored
assert.strictEqual(filterTodos(todos, {}).length, 5);

console.log('PASS');
