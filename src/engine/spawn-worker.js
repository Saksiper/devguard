'use strict';

// Spawn the seed-note worker as a DETACHED background process that OUTLIVES the hook.
// `detached:true` + `stdio:'ignore'` + `.unref()` lets the parent hook call respond()/exit
// immediately while the worker keeps running (Windows-survivable — verified by the T0 probe).
// NOTE: we do NOT pass a custom `env`, so the child inherits process.env — critically
// CLAUDE_PLUGIN_DATA — and therefore opens the SAME database the hook used.

const path = require('path');
const { debugLog } = require('./debug-log');

function spawnSeedNoteWorker(projectPath) {
  try {
    const { spawn } = require('child_process');
    const workerPath = path.join(__dirname, '..', 'workers', 'seed-note-worker.js');
    let child;
    if (process.platform === 'win32') {
      // On Windows, `detached:true` alone does NOT break the child out of the parent hook's
      // job object, so the worker dies the moment the hook process exits (verified: a detached
      // spawn survives while the parent is alive, but not after the hook returns). Launch via
      // cmd `start` — an empty-title ("") then the quoted exe — which creates a fully
      // independent process that outlives the hook. windowsVerbatimArguments so we control the
      // quoting (paths may contain spaces, e.g. "C:\Program Files\nodejs\node.exe").
      const cmd = `start "" /b "${process.execPath}" "${workerPath}" "${projectPath}"`;
      child = spawn('cmd.exe', ['/c', cmd], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(process.execPath, [workerPath, projectPath], {
        detached: true, stdio: 'ignore',
      });
    }
    child.unref();
    return child.pid || null;
  } catch (err) {
    debugLog('spawn-worker', 'spawn failed (non-fatal)', { error: String(err) });
    return null;
  }
}

// Guarded spawn for the Stop/SessionEnd hooks: only spawn when the feature is enabled AND
// there is actually claimable work (a turn during an active drain sees rows claimed-but-not-
// stale and does NOT spawn a doomed process). Kill-switch (config + env) mirrors enqueue.
// deps.spawn is a DI seam for tests. Fully non-fatal — a spawn failure must not break the hook.
function maybeSpawnSeedWorker(db, config, projectPath, deps = {}) {
  const spawnFn = deps.spawn || spawnSeedNoteWorker;
  try {
    if (!config || !config.seed_note_enabled) return null;
    if (process.env.DEVGUARD_LLM_DISABLED === '1') return null;
    if (db.countClaimableSeedNotes() <= 0) return null;
    const pid = spawnFn(projectPath);
    debugLog('spawn-worker', 'seed worker spawned', { pid });
    return pid;
  } catch (err) {
    debugLog('spawn-worker', 'maybeSpawn failed (non-fatal)', { error: String(err) });
    return null;
  }
}

module.exports = { spawnSeedNoteWorker, maybeSpawnSeedWorker };
