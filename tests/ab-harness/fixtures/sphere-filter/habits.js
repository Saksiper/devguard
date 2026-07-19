'use strict';

// Tiny in-memory habit log. Entries: { id, title, ts, status }.
// ts is an epoch-milliseconds number; status is 'active' | 'done' | 'skipped'.

let nextId = 1;

function createLog() {
  return { entries: [] };
}

function addEntry(log, title, ts, status = 'active') {
  const entry = { id: nextId++, title, ts, status };
  log.entries.push(entry);
  return entry;
}

function listEntries(log) {
  return log.entries;
}

module.exports = { createLog, addEntry, listEntries };
