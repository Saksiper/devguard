'use strict';

// Tiny in-memory log store. Lines: { id, level, msg, ts } (ts = epoch ms).
// level is one of 'debug' | 'info' | 'warn' | 'error'.

let nextId = 1;

function createLog() {
  return { lines: [] };
}

function addLine(log, level, msg, ts) {
  const line = { id: nextId++, level, msg, ts };
  log.lines.push(line);
  return line;
}

function listLines(log) {
  return log.lines;
}

module.exports = { createLog, addLine, listLines };
