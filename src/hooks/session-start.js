'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readInput, respond, context } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');

const MANUAL_DEP_WARNING =
  'DevGuard is installed but INACTIVE: its native dependency (better-sqlite3) is not built. '
  + 'Run `npm install` in the DevGuard plugin directory, then start a new session.';

// Self-healing install: the marketplace copies the plugin but never runs npm, so
// the native module is missing on a fresh install. On the FIRST session start we
// run the install ourselves (blocking, one-time). Every later hook this session is
// a fresh process that will then load better-sqlite3, so DevGuard is active for the
// rest of the session without a second restart. A marker guards against a failing
// install blocking every subsequent session start.
function handleMissingDeps() {
  let marker = null;
  try {
    const { getDbPath } = require('../engine/db');
    marker = path.join(path.dirname(getDbPath()), '.devguard-autoinstall-attempted');
  } catch { /* getDbPath is pure, but stay defensive */ }

  if (marker) {
    try {
      // The data dir may not exist yet on a truly fresh install (openDb threw
      // before it could create it).
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      // Atomic claim ('wx' fails if it already exists): records the attempt
      // BEFORE running so a hang/crash can't retry-block, AND lets only ONE of
      // two concurrent session starts run the install (the loser falls back,
      // avoiding a corrupt parallel npm write into the same node_modules).
      fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' });
    } catch {
      // Already attempted (EEXIST) or the data dir is unwritable (DevGuard can't
      // run there anyway) → don't install here; guide the user manually.
      context(MANUAL_DEP_WARNING, 'SessionStart');
      return;
    }
  }

  const cmd = process.env.DEVGUARD_AUTOINSTALL_CMD || 'npm install';
  try {
    // stdio 'ignore' is REQUIRED: npm output on stdout would corrupt this hook's
    // JSON. timeout < the hooks.json SessionStart timeout so we fail catchably.
    require('child_process').execSync(cmd, {
      cwd: path.join(__dirname, '..', '..'), timeout: 110000, stdio: 'ignore',
    });
    context('DevGuard: dependencies installed — active for this session.', 'SessionStart');
  } catch (e) {
    debugLog('session-start', 'Auto-install failed', { error: String(e && e.message) });
    context(MANUAL_DEP_WARNING, 'SessionStart');
  }
}

// One-time, user-VISIBLE heads-up that enabling seed notes (default-ON) triggers a
// ~1.3GB local model download. The worker itself runs stdio:'ignore' and cannot print,
// so the notice has to live in a hook that can. A sentinel file in the model dir makes it
// show exactly once (ever), never per-session. Silent when disabled, offline, or the model
// is already present. Fail-safe: any error → no notice (never blocks session start).
function maybeSeedDownloadNotice(config) {
  try {
    if (!config || !config.seed_note_enabled) return null;
    if (process.env.DEVGUARD_LLM_DISABLED === '1' || process.env.DEVGUARD_OFFLINE) return null;
    const { getModelDir } = require('../engine/llm-note');
    const dir = getModelDir();
    if (fs.existsSync(path.join(dir, 'onnx-community', 'Qwen3-1.7B-ONNX'))) return null; // already downloaded
    const sentinel = path.join(dir, '.seed_download_notified');
    if (fs.existsSync(sentinel)) return null; // already notified once
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString());
    return 'DevGuard will do a one-time ~1.3GB local model download to write "seed" purpose '
      + 'notes for new files. Disable with DEVGUARD_LLM_DISABLED=1.';
  } catch {
    return null;
  }
}

function main() {
  const timer = createTimer('session-start');
  timer.start();

  try {
    const input = readInput();
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());
    debugLog('session-start', 'Hook triggered', { projectPath });

    const db = getDb(projectPath);

    const sessionId = input.session_id || crypto.randomUUID();
    db.insertSession(sessionId);
    debugLog('session-start', 'Session created', { sessionId });

    // Orphan cleanup: remove data for deleted projects. Only treat a path as
    // orphaned when its volume root IS reachable but the directory is gone — an
    // unplugged USB drive or disconnected network share must not wipe history.
    try {
      const allPaths = db.getDistinctProjectPaths();
      for (const p of allPaths) {
        if (p === projectPath) continue;
        const root = path.parse(p).root;
        if (root && fs.existsSync(root) && !fs.existsSync(p)) {
          debugLog('session-start', 'Cleaning orphan project', { path: p });
          db.deleteByProjectPath(p);
        }
      }
    } catch (err) {
      debugLog('session-start', 'Orphan cleanup failed (non-fatal)', { error: String(err) });
    }

    // Blame cache TTL: delete entries older than 7 days
    db.deleteOldBlameCacheEntries(7);

    // FIFO: limit DB size per project
    const { loadConfig } = require('../engine/config');
    const config = loadConfig(projectPath);
    db.runFifo(config.max_entries);

    // Auto-promote: scan detection_log for recurring TP patterns
    try {
      const { applyAutoPromote } = require('../engine/auto-promote');
      const promoted = applyAutoPromote(db, config);
      if (promoted > 0) {
        debugLog('session-start', 'Auto-promote applied', { promoted });
      }
    } catch (err) {
      debugLog('session-start', 'Auto-promote failed (non-fatal)', { error: String(err) });
    }

    // Backfill: replay edits from transcripts that live hooks missed
    // (Desktop / web / subagent channels). Bounded + non-blocking.
    try {
      const { runBackfill } = require('../engine/backfill');
      const bf = runBackfill();
      if (bf && bf.editsInserted > 0) {
        debugLog('session-start', 'Backfill applied', bf);
      }
    } catch (err) {
      debugLog('session-start', 'Backfill failed (non-fatal)', { error: String(err) });
    }

    // Orphan compliance backstop: a hard-killed terminal never fires SessionEnd, so
    // prior sessions' surfaced-but-unacked notes never get a terminal outcome. Finalize
    // stale prior sessions (last activity older than the threshold) as 'lapsed'. After
    // backfill so replayed edits count toward last-activity. Non-fatal.
    try {
      const bs = db.finalizeStaleSessions({
        excludeSessionId: sessionId,
        staleAfterHours: config.finalize_stale_after_hours,
      });
      if (bs && bs.emitted > 0) {
        debugLog('session-start', 'Orphan backstop finalize applied', bs);
      }
    } catch (err) {
      debugLog('session-start', 'Orphan backstop finalize failed (non-fatal)', { error: String(err) });
    }

    // Onboarding: show message on first use for this project. Gated on the
    // intervention toggle — in passive/control mode the banner would tell Claude
    // it is being watched (Hawthorne effect) and contaminate A/B measurement.
    const notices = [];
    const sessionCount = db.getSessionCount();
    if (sessionCount === 1 && config.intervention_enabled) {
      notices.push('DevGuard active. Cycle detection and protection monitoring enabled.');
    }
    const dlNotice = maybeSeedDownloadNotice(config);
    if (dlNotice) notices.push(dlNotice);

    closeDb();
    timer.elapsed(notices.length ? 'Completed (with notice)' : 'Completed');
    if (notices.length) { context(notices.join(' '), 'SessionStart'); return; }
    respond({});
  } catch (err) {
    debugLog('session-start', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    if (String(err).includes('better-sqlite3 unavailable')) {
      // Fresh install without built native deps: try to fix it ourselves, once.
      handleMissingDeps();
      return;
    }
    respond({});
  }
}

module.exports = { maybeSeedDownloadNotice };

if (require.main === module) {
  main();
}

