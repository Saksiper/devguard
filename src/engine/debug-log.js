'use strict';

function debugLog(module, message, data) {
  if (process.env.DEVGUARD_DEBUG !== '1') return;

  let line = `[DevGuard:${module}] ${new Date().toISOString()} ${message}`;

  if (data !== undefined) {
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch (_) {
      serialized = '"[circular]"';
    }
    line += ` ${serialized}`;
  }

  process.stderr.write(line + '\n');
}

function createTimer(module) {
  let startTime;

  return {
    start() {
      startTime = Date.now();
    },
    elapsed(message) {
      const duration = Date.now() - startTime;
      debugLog(module, `${message} (${duration}ms)`);
    },
  };
}

module.exports = { debugLog, createTimer };
