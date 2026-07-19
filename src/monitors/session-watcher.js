'use strict';

const Database = require('better-sqlite3');
const { debugLog } = require('../engine/debug-log');
const { loadConfig } = require('../engine/config');
// Canonical DB path resolution (incl. plugin-data scan fallback) — a private
// copy here used to point the monitor at an empty ~/.devguard DB whenever
// CLAUDE_PLUGIN_DATA was absent.
const { getDbPath } = require('../engine/db');

const VELOCITY_WINDOW_MINUTES = 2;
const BOUNCE_WINDOW = 10;
const HOOK_LOOKBACK_MINUTES = 5;
const VELOCITY_COOLDOWN_MS = 5 * 60 * 1000;
const BOUNCE_COOLDOWN_MS = 5 * 60 * 1000;
const EFFECTIVENESS_COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  sessionId: null,
  fatigueWarned: false,
  velocityCooldowns: new Map(),
  lastBounceHash: null,
  lastBounceTime: 0,
  effectivenessCooldowns: new Map(),
};

function emit(message) {
  const line = `I'm DevGuard (session monitor). ${message}`;
  process.stdout.write(line + '\n');
  debugLog('session-watcher', 'Emitted', { message: message.substring(0, 120) });
}

function openReadonly() {
  return new Database(getDbPath(), { readonly: true });
}

function getProjectPath() {
  const { normalizeProjectPath } = require('../engine/normalize-path');
  return normalizeProjectPath(process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, '/');
}

function getLatestSession(db, pp) {
  return db.prepare(
    'SELECT * FROM sessions WHERE project_path = ? ORDER BY id DESC LIMIT 1'
  ).get(pp) || null;
}

function getRecentHookWarns(db, pp, sessionId) {
  try {
    return db.prepare(
      `SELECT DISTINCT file FROM detection_log
       WHERE project_path = ? AND session_id = ?
         AND decision IN ('warn', 'block')
         AND detected_at > datetime('now', '-${HOOK_LOOKBACK_MINUTES} minutes')`
    ).all(pp, sessionId).map(r => r.file);
  } catch {
    return [];
  }
}

// --- Pattern A: Edit Velocity (Thrashing) ---

function checkEditVelocity(db, pp, sessionId, config, hookWarnedFiles) {
  const threshold = config.monitor_velocity_threshold ?? 5;
  try {
    const rows = db.prepare(
      `SELECT file, COUNT(*) as cnt FROM changes
       WHERE project_path = ? AND session_id = ?
         AND timestamp > datetime('now', '-${VELOCITY_WINDOW_MINUTES} minutes')
       GROUP BY file HAVING cnt >= ?`
    ).all(pp, sessionId, threshold);

    const now = Date.now();
    for (const [f, t] of state.velocityCooldowns) {
      if (now - t >= VELOCITY_COOLDOWN_MS) state.velocityCooldowns.delete(f);
    }
    for (const row of rows) {
      if (hookWarnedFiles.includes(row.file)) continue;
      const lastCooldown = state.velocityCooldowns.get(row.file) || 0;
      if (now - lastCooldown < VELOCITY_COOLDOWN_MS) continue;

      const short = row.file.replace(/.*[/\\]/, '');
      emit(
        `You've made ${row.cnt} edits to ${short} in the last ${VELOCITY_WINDOW_MINUTES} minutes. ` +
        `This pace suggests rapid trial-and-error. What is the root cause you're trying to fix?`
      );
      state.velocityCooldowns.set(row.file, now);
    }
  } catch (err) {
    debugLog('session-watcher', 'velocity check error', { error: String(err) });
  }
}

// --- Pattern B: Cross-File Bouncing ---

function checkCrossFileBounce(db, pp, sessionId) {
  try {
    const rows = db.prepare(
      `SELECT file FROM changes
       WHERE project_path = ? AND session_id = ?
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    ).all(pp, sessionId, BOUNCE_WINDOW);

    if (rows.length < BOUNCE_WINDOW) return;

    const files = rows.map(r => r.file);
    const uniqueFiles = [...new Set(files)];

    if (uniqueFiles.length > 3 || uniqueFiles.length < 2) return;

    const allRepeat = uniqueFiles.every(f => files.filter(x => x === f).length >= 2);
    if (!allRepeat) return;

    const bounceHash = uniqueFiles.sort().join('|');
    const now = Date.now();
    if (bounceHash === state.lastBounceHash && now - state.lastBounceTime < BOUNCE_COOLDOWN_MS) return;

    const shortNames = uniqueFiles.map(f => f.replace(/.*[/\\]/, '')).join(', ');
    emit(
      `You're bouncing between ${shortNames} — the last ${BOUNCE_WINDOW} edits only touched these files. ` +
      `This pattern often indicates a dependency you haven't addressed. What connects these files?`
    );
    state.lastBounceHash = bounceHash;
    state.lastBounceTime = now;
  } catch (err) {
    debugLog('session-watcher', 'bounce check error', { error: String(err) });
  }
}

// --- Pattern C: Warn Effectiveness ---

function checkWarnEffectiveness(db, pp, sessionId) {
  try {
    const warns = db.prepare(
      `SELECT id, file, detected_at FROM detection_log
       WHERE project_path = ? AND session_id = ?
         AND decision = 'warn' AND next_change_same_file = 1
         AND detected_at > datetime('now', '-10 minutes')
       ORDER BY detected_at DESC LIMIT 10`
    ).all(pp, sessionId);

    const fileCounts = new Map();
    for (const w of warns) {
      fileCounts.set(w.file, (fileCounts.get(w.file) || 0) + 1);
    }

    const now = Date.now();
    for (const [f, t] of state.effectivenessCooldowns) {
      if (now - t >= EFFECTIVENESS_COOLDOWN_MS) state.effectivenessCooldowns.delete(f);
    }
    for (const [file, count] of fileCounts) {
      if (count < 3) continue;
      const lastCooldown = state.effectivenessCooldowns.get(file) || 0;
      if (now - lastCooldown < EFFECTIVENESS_COOLDOWN_MS) continue;

      const short = file.replace(/.*[/\\]/, '');
      emit(
        `DevGuard warned about ${short} earlier, but ${count} more edits followed on the same file. ` +
        `What specifically makes you confident this approach will work?`
      );
      state.effectivenessCooldowns.set(file, now);
    }
  } catch (err) {
    debugLog('session-watcher', 'effectiveness check error', { error: String(err) });
  }
}

// --- Pattern D: Session Fatigue ---

function checkSessionFatigue(db, pp, sessionId, config) {
  if (state.fatigueWarned) return;
  const threshold = config.monitor_fatigue_threshold ?? 50;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM changes
       WHERE project_path = ? AND session_id = ?`
    ).get(pp, sessionId);

    if (!row || row.cnt < threshold) return;

    emit(
      `This session has reached ${row.cnt} changes. Long sessions often lead to accumulated context debt. ` +
      `Consider: what's the current state of your changes? Is there a clean commit point you can reach?`
    );
    state.fatigueWarned = true;
  } catch (err) {
    debugLog('session-watcher', 'fatigue check error', { error: String(err) });
  }
}

// --- Polling ---

function poll(projectPath) {
  let db = null;
  try {
    const config = loadConfig(projectPath);
    if (config.monitor_enabled === false) return;

    const pp = projectPath.replace(/\\/g, '/');
    db = openReadonly();
    const session = getLatestSession(db, pp);
    if (!session) { db.close(); return; }

    if (state.sessionId !== session.session_id) {
      state.sessionId = session.session_id;
      state.fatigueWarned = false;
      state.velocityCooldowns.clear();
      state.lastBounceHash = null;
      state.lastBounceTime = 0;
      state.effectivenessCooldowns.clear();
      debugLog('session-watcher', 'New session detected', { sessionId: session.session_id });
    }

    const hookWarnedFiles = getRecentHookWarns(db, pp, session.session_id);

    checkEditVelocity(db, pp, session.session_id, config, hookWarnedFiles);
    checkCrossFileBounce(db, pp, session.session_id);
    checkWarnEffectiveness(db, pp, session.session_id);
    checkSessionFatigue(db, pp, session.session_id, config);

    db.close();
  } catch (err) {
    debugLog('session-watcher', 'Poll error', { error: String(err) });
    if (db) { try { db.close(); } catch { /* graceful */ } }
  }
}

// --- Main ---

function main() {
  const projectPath = getProjectPath();
  const config = loadConfig(projectPath);
  const intervalMs = (config.monitor_interval ?? 30) * 1000;

  debugLog('session-watcher', 'Starting monitor', { projectPath, intervalMs });

  poll(projectPath);
  const intervalId = setInterval(() => poll(projectPath), intervalMs);

  const shutdown = () => {
    clearInterval(intervalId);
    debugLog('session-watcher', 'Shutting down');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    debugLog('session-watcher', 'Uncaught exception', { error: String(err) });
    shutdown();
  });
}

module.exports = {
  emit, poll, state, openReadonly, getDbPath, getProjectPath,
  getLatestSession, getRecentHookWarns,
  checkEditVelocity, checkCrossFileBounce,
  checkWarnEffectiveness, checkSessionFatigue,
  VELOCITY_WINDOW_MINUTES, BOUNCE_WINDOW, HOOK_LOOKBACK_MINUTES,
  VELOCITY_COOLDOWN_MS, BOUNCE_COOLDOWN_MS, EFFECTIVENESS_COOLDOWN_MS,
};

if (require.main === module) {
  main();
}
