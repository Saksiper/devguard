'use strict';

const { readInput, respond } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');
const { normalizeProjectPath } = require('../engine/normalize-path');
const { captureNoteFromTranscript, captureAckCompliance } = require('../engine/note-capture');
const { flushPendingVerdicts } = require('./post-edit');

// SessionEnd backstop: on a graceful close, replay the final assistant reply and
// capture any DG-NOTE marker. Same capture core as the Stop hook. Idempotency is
// content-based inside captureNoteFromTranscript, so Stop having already captured
// then SessionEnd firing on the same transcript does NOT double-write.
function main() {
  const timer = createTimer('session-end');
  timer.start();

  try {
    const input = readInput();
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());
    const transcriptPath = input.transcript_path || null;
    const sessionId = input.session_id || null;
    debugLog('session-end', 'Hook triggered', { projectPath, sessionId, transcriptPath });

    if (!transcriptPath) {
      timer.elapsed('No transcript');
      respond({});
      return;
    }

    const db = getDb(projectPath);
    const noteId = captureNoteFromTranscript(db, { transcriptPath, sessionId });
    debugLog('session-end', 'Capture done', { noteId });

    // Ack harvest after the note capture (same order as stop.js) — idempotent with
    // the Stop harvest via the tracked-existence dedup in ackNoteCompliance.
    try {
      if (sessionId) captureAckCompliance(db, { transcriptPath, sessionId });
    } catch (err) {
      debugLog('session-end', 'ack harvest failed (non-fatal)', { error: String(err) });
    }

    // Backstop the terminal edit's retrospective verdict (see stop.js). Idempotent
    // with the Stop flush — captured verdicts drop out of the candidate filter.
    // Drive by input.session_id (g2), not getLatestSession — see stop.js.
    try {
      if (sessionId) flushPendingVerdicts(db, sessionId, transcriptPath);
    } catch (err) {
      debugLog('session-end', 'verdict flush failed (non-fatal)', { error: String(err) });
    }

    // Finalize LAST: whatever is still surfaced-untracked was never acknowledged
    // this session — 'superseded' if the head moved past the note, else 'ignored'.
    try {
      if (sessionId) db.finalizeNoteCompliance(sessionId);
    } catch (err) {
      debugLog('session-end', 'compliance finalize failed (non-fatal)', { error: String(err) });
    }

    closeDb();
    timer.elapsed('Completed');
    respond({});
  } catch (err) {
    debugLog('session-end', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

if (require.main === module) {
  main();
}
