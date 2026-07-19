'use strict';

const { debugLog } = require('./debug-log');

const VALID_KINDS = new Set([
  'fired',
  'marker_found',
  'marker_malformed',
  'node_unresolved',
  'ack_found',
  'ack_unmatched',
  'ack_node_unresolved',
  'ack_echoless',
]);

function recordCanary(kind, detail) {
  try {
    if (VALID_KINDS.has(kind)) {
      debugLog('sphere-canary', kind, detail);
    } else {
      const marked =
        detail && typeof detail === 'object'
          ? { ...detail, unknown_kind: true }
          : { detail, unknown_kind: true };
      debugLog('sphere-canary', kind, marked);
    }
  } catch (_) {
    // Non-blocking observability recorder: never throw.
  }
}

module.exports = { recordCanary };
