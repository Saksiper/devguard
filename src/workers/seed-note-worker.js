'use strict';

// Seed-note worker (SEED-COLDSTART · T3-core). Runs as a SEPARATE process so the local
// LLM's slow inference never blocks a hook. It drains pending_seed_notes: for each job
// it asks the local model for the file's lasting purpose and writes a low-confidence
// (confidence_level=1) seed note under the node, which a real [DG-NOTE] later supersedes.
//
// Idempotent: a node that already has a head note is skipped (a real note or a prior
// seed won the race). Every job is deleted after handling — success, skip, or a null/
// error generation — so a poison row can never loop forever. Non-blocking + fail-safe:
// individual job failures are swallowed; the process exits 0.
//
// This is the WALKING-SKELETON core. Single-flight (DB-atomic claim), zombie-guard, and
// the idle-lifetime keepalive from the plan are deliberately NOT here yet — they harden
// this loop once the end-to-end path is proven.

const { debugLog } = require('../engine/debug-log');

// deps.generate is a DI seam for tests: (file, code) => Promise<string|null>.
// Default delegates to the real local-LLM purpose generator.
async function runWorker(projectPath, deps = {}) {
  const { getDb, closeDb } = require('../engine/db');
  const { computeFileFingerprint } = require('../engine/file-fingerprint');
  const generate = deps.generate || ((file, code) => require('../engine/llm-note').generatePurpose({ file, code }));

  const db = getDb(projectPath);
  let created = 0;
  try {
    const jobs = db.getPendingSeedNotes();
    debugLog('seed-worker', 'draining', { projectPath, jobs: jobs.length });

    for (const job of jobs) {
      try {
        // Idempotent: a head note already exists (real note or earlier seed) — drop the job.
        if (db.getHeadNoteByNode(job.node_id)) { db.deleteSeedNote(job.id); continue; }

        const purpose = await generate(job.file, job.code);
        if (purpose) {
          const fp = job.file ? computeFileFingerprint(job.file) : null;
          db.transaction(() => {
            const newId = db.insertNote({
              node_id: job.node_id,
              source: 'seed_purpose',
              note_text: purpose,
              file: job.node_id, // sphere notes store the node_id in `file`
              confidence_level: 1,
              session_id: job.session_id,
              related_change_id: job.change_id,
              source_file: job.file,
              code_fingerprint: fp,
            });
            db.supersedePriorHead(job.node_id, newId);
            db.insertNoteEvent({
              note_id: newId,
              session_id: job.session_id,
              change_id: job.change_id,
              event_type: 'seed_created',
              payload: { node_id: job.node_id },
            });
          });
          created++;
          debugLog('seed-worker', 'seed written', { node_id: job.node_id });
        }
        db.deleteSeedNote(job.id); // handled (written or null) — never re-loop
      } catch (err) {
        debugLog('seed-worker', 'job failed (non-fatal)', { id: job.id, error: String(err) });
        try { db.deleteSeedNote(job.id); } catch { /* ignore */ }
      }
    }
  } finally {
    try { closeDb(); } catch { /* ignore */ }
  }
  return created;
}

module.exports = { runWorker };

if (require.main === module) {
  const projectPath = process.argv[2] || process.cwd();
  runWorker(projectPath)
    .then((n) => { debugLog('seed-worker', 'done', { created: n }); process.exit(0); })
    .catch((err) => { debugLog('seed-worker', 'fatal', { error: String(err) }); process.exit(0); });
}
