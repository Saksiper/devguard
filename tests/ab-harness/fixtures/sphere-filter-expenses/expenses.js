'use strict';

// Tiny in-memory expense log. Rows: { id, desc, amountCents, category, ts }.
// amountCents is an integer number of cents; ts is an epoch-milliseconds number.

let nextId = 1;

function createLog() {
  return { rows: [] };
}

function addExpense(log, desc, amountCents, category, ts) {
  const row = { id: nextId++, desc, amountCents, category, ts };
  log.rows.push(row);
  return row;
}

function listExpenses(log) {
  return log.rows;
}

module.exports = { createLog, addExpense, listExpenses };
