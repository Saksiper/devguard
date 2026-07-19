'use strict';

const { readInput, respond } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');
const { captureNoteFromTranscript, captureAckCompliance } = require('../engine/note-capture');
const { flushPendingVerdicts } = require('./post-edit');

function main() {
  const timer = createTimer('stop');
  timer.start();

  try {
    const input = readInput();
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());
    debugLog('stop', 'Hook triggered', {
      projectPath,
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
    });

    const db = getDb(projectPath);
    captureNoteFromTranscript(db, {
      transcriptPath: input.transcript_path,
      sessionId: input.session_id,
    });

    // Ack harvest AFTER the note capture: the reply's DG-NOTE layers the new head
    // first, then the [DG-CONTINUE/PIVOT/PAUSE] tag credits the surfaced note
    // ('complied'). No finalize here — an early 'ignored' would permanently block
    // an ack arriving on a later turn (finalize is SessionEnd's job).
    try {
      if (input.session_id) {
        captureAckCompliance(db, { transcriptPath: input.transcript_path, sessionId: input.session_id });
      }
    } catch (err) {
      debugLog('stop', 'ack harvest failed (non-fatal)', { error: String(err) });
    }

    // Flush the terminal edit's verdict: attribution otherwise only fires on a
    // SUBSEQUENT post-edit, so the final (or only) edit of a session would never
    // get one. Drive the flush by input.session_id (g2): getLatestSession() returns
    // the highest-id session, which under concurrent headless 'claude -p' is the
    // WRONG session, so the terminal edit would never flush.
    try {
      if (input.session_id) flushPendingVerdicts(db, input.session_id, input.transcript_path);
    } catch (err) {
      debugLog('stop', 'verdict flush failed (non-fatal)', { error: String(err) });
    }

    closeDb();
    timer.elapsed('Completed');
    respond({});
  } catch (err) {
    debugLog('stop', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

module.exports = { main };

if (require.main === module) {
  main();
}
