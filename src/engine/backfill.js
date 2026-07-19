'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { debugLog } = require('./debug-log');
const { extractEdits } = require('./transcript-parser');

// Recursively collect *.jsonl files (including subagents/ subfolders) with their
// size + mtime. Bounded by maxFiles after sorting, so the walk itself is cheap.
function collectTranscripts(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, non-fatal
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        collectTranscripts(full, out);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(full);
        out.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch {
      /* stat/read race — skip this entry */
    }
  }
}

// Scan Claude Code transcripts and replay edits that live hooks missed
// (Desktop / web / subagent channels). Idempotent via per-transcript cursor +
// the (project_path, tool_use_id) unique index. NEVER throws to the caller.
function runBackfill({ projectsDir, maxFiles = 40, maxEdits = 500, now } = {}) {
  void now;
  const stats = { filesScanned: 0, editsInserted: 0, editsSkipped: 0, editsExcluded: 0, errors: 0 };

  try {
    const root = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return stats;

    // Cursor proxy: backfill_cursor is transcript-global (no project_path filter),
    // so any non-empty project path yields a proxy with working cursor methods.
    const db = require('./db');
    const cursorDb = db.getDb(root);

    const { loadConfig } = require('./config');
    const { isExcluded } = require('./path-matcher');
    const configCache = new Map(); // per-project config, loaded once per run

    // Load all cursors in ONE query, then look them up from the Map — avoids a
    // per-file SELECT (one round-trip per transcript on every SessionStart).
    let cursorMap;
    try {
      cursorMap = cursorDb.getAllBackfillCursors();
    } catch (e) {
      debugLog('backfill', 'cursor load failed (non-fatal)', { error: String(e && e.message) });
      return stats;
    }

    const all = [];
    collectTranscripts(root, all);
    all.sort((a, b) => b.mtime - a.mtime);

    let budget = maxEdits;
    let processedFiles = 0;

    for (const file of all) {
      if (processedFiles >= maxFiles) break;

      const cursor = cursorMap.get(file.path) || 0;

      // Only files with new bytes count against the maxFiles budget.
      if (file.size <= cursor) continue;
      processedFiles++;
      stats.filesScanned++;

      try {
        const { edits, bytesRead } = extractEdits(file.path, cursor);
        let truncated = false;
        let fileErrors = 0;

        for (const edit of edits) {
          if (!edit || !edit.file || !edit.project_path) continue;
          // extractEdits only returns edits whose successful result was seen in the
          // window (orphan/failed edits are excluded there); defensive double-check.
          if (edit.resolved !== true) continue;

          // Live hooks skip excluded paths (post-edit → isExcluded); apply the same
          // filter here or backfill re-imports what capture deliberately drops
          // (.claude/ memory files, node_modules, plugin cache, …).
          if (!configCache.has(edit.project_path)) {
            configCache.set(edit.project_path, loadConfig(edit.project_path));
          }
          if (isExcluded(edit.file, configCache.get(edit.project_path), edit.project_path)) {
            stats.editsExcluded++;
            continue;
          }

          if (budget <= 0) {
            truncated = true;
            debugLog('backfill', 'maxEdits budget reached — stopping scan', { file: file.path });
            break;
          }

          const projDb = db.getDb(edit.project_path);
          try {
            projDb.insertChange({
              file: edit.file,
              action: edit.action,
              description: edit.description,
              diff_text: edit.diff_text,
              session_id: edit.session_id,
              tool_use_id: edit.tool_use_id,
              source: 'transcript_backfill',
              timestamp: edit.timestamp,
            });
            stats.editsInserted++;
            budget--;
          } catch (e) {
            // Only a UNIQUE/PK collision means "already imported on a prior run".
            // Surface anything else (NOT NULL, FK, …) instead of swallowing it.
            if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')) {
              stats.editsSkipped++;
            } else {
              stats.errors++;
              fileErrors++;
              debugLog('backfill', 'insertChange failed (non-fatal)', { file: edit.file, error: String(e && e.message) });
            }
          }
        }

        // Advance the cursor ONLY if the whole file was processed cleanly. If we
        // hit the budget mid-file OR any insert failed for a real reason, leave
        // the cursor so those edits are retried next run instead of lost forever
        // (already-imported ones re-skip cheaply via the UNIQUE index).
        if (!truncated && fileErrors === 0) {
          cursorDb.setBackfillCursor(file.path, bytesRead);
        }

        if (truncated) break; // global budget exhausted — stop the whole run
      } catch (e) {
        stats.errors++;
        debugLog('backfill', 'file processing failed (non-fatal)', { file: file.path, error: String(e && e.message) });
      }
    }

    debugLog('backfill', 'run complete', stats);
  } catch (e) {
    stats.errors++;
    debugLog('backfill', 'run failed (non-fatal)', { error: String(e && e.message) });
  }

  return stats;
}

module.exports = { runBackfill };
