'use strict';

// Seed-note worker (SEED-COLDSTART · T3). Runs as a SEPARATE detached process (spawned by
// the Stop/SessionEnd hooks) so the local LLM's slow inference never blocks a hook. It drains
// pending_seed_notes: for each job it asks the local model for the file's lasting purpose and
// writes a low-confidence (confidence_level=1) seed note, which a real [DG-NOTE] later supersedes.
//
// Hardening (per plan + provocateur review):
//  - LIVE-WORKER GUARD: if another worker holds a fresh claim, exit before loading a model
//    (prevents two 1.3GB models running at once).
//  - SINGLE-FLIGHT CLAIM: atomically claim rows; if 0 claimed, exit.
//  - ZOMBIE-GUARD: only process jobs whose node still lacks a head note; if none are valid,
//    exit WITHOUT loading the model (a cancelled/superseded session must not trigger a
//    1.3GB download for moot work).
//  - DISK-GUARD: before the first model load, require ~3GB free (unless the model is already
//    present); otherwise skip gracefully — no half-download.
// Every claimed job is deleted after handling (success, skip, or null/error) so a poison row
// can never loop forever. Non-blocking + fail-safe: the process always exits 0.
//
// NO idle-lifetime: per-turn spawn + single-flight is the model. A detached background model
// reload costs the user nothing, so keeping a daemon alive would be pure risk (provocateur #2).

const path = require('path');
const { debugLog } = require('../engine/debug-log');

// True if the model download can proceed: the model is already present (no download), or the
// drive holding the model dir has ~3GB free. Fail-open on any stat error (don't block on IO).
function defaultHasEnoughDisk() {
  try {
    const fs = require('fs');
    const { getModelDir } = require('../engine/llm-note');
    const dir = getModelDir();
    if (fs.existsSync(path.join(dir, 'onnx-community'))) return true; // already downloaded
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize > 3 * 1024 * 1024 * 1024;
  } catch {
    return true;
  }
}

// deps.generate: (file, code) => Promise<string|null> (default = real local LLM).
// deps.hasEnoughDisk: () => boolean (default = real disk check).
async function runWorker(projectPath, deps = {}) {
  const { getDb, closeDb } = require('../engine/db');
  const { computeFileFingerprint } = require('../engine/file-fingerprint');
  const generate = deps.generate || ((file, code) => require('../engine/llm-note').generatePurpose({ file, code }));
  const hasEnoughDisk = deps.hasEnoughDisk || defaultHasEnoughDisk;
  const pid = process.pid;

  const db = getDb(projectPath);
  let created = 0;
  try {
    // (1) Another worker is already running — don't double-load a model.
    if (db.hasLiveClaim(pid)) { debugLog('seed-worker', 'live claim held by another worker, exit', { pid }); return 0; }

    // (2) Atomic single-flight claim. Nothing claimable -> exit.
    const claimed = db.claimSeedNotes(pid);
    if (claimed === 0) { debugLog('seed-worker', 'nothing claimed, exit', { pid }); return 0; }
    const jobs = db.getClaimedSeedNotes(pid);

    // (3) Zombie-guard: drop jobs whose node already has a head note (already handled);
    //     only load a model if at least one job is still valid.
    const valid = [];
    for (const j of jobs) {
      if (db.getHeadNoteByNode(j.node_id)) { try { db.deleteSeedNote(j.id); } catch { /* ignore */ } }
      else valid.push(j);
    }
    if (valid.length === 0) { debugLog('seed-worker', 'no valid jobs, exit without model load'); return 0; }

    // (4) Disk-guard before the first (possibly downloading) model load.
    if (!hasEnoughDisk()) {
      debugLog('seed-worker', 'insufficient disk, skip model load', { count: valid.length });
      for (const j of valid) { try { db.deleteSeedNote(j.id); } catch { /* ignore */ } }
      return 0;
    }

    // (5) Drain valid jobs.
    for (const job of valid) {
      try {
        if (db.getHeadNoteByNode(job.node_id)) { db.deleteSeedNote(job.id); continue; } // race re-check
        const purpose = await generate(job.file, job.code);
        if (purpose) {
          const fp = job.file ? computeFileFingerprint(job.file) : null;
          db.transaction(() => {
            const newId = db.insertNote({
              node_id: job.node_id,
              source: 'seed_purpose',
              note_text: purpose,
              file: job.node_id,
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
        db.deleteSeedNote(job.id);
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
