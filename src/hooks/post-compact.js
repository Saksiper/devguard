'use strict';

const fs = require('fs');
const path = require('path');
const { readInput, respond } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');

// Nothing ever closes an issue today, so without an age window a months-old row
// is re-injected into every session forever (measured live: a 2026-05-23
// manual-test issue still surfacing in July).
const SUMMARY_ISSUE_MAX_AGE_DAYS = 7;

function parseDbTs(s) {
  if (!s) return null;
  const iso = String(s).replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function buildSummary(db, sessionId) {
  const lines = ['DevGuard Session Summary:'];

  const cutoff = Date.now() - SUMMARY_ISSUE_MAX_AGE_DAYS * 86400e3;
  const issues = db.getIssues({ status: 'open' })
    // Unknown first_seen stays (fail-open); known-stale rows drop.
    .filter((i) => { const t = parseDbTs(i.first_seen); return t === null || t >= cutoff; })
    .sort((a, b) => (b.id || 0) - (a.id || 0));
  if (issues.length > 0) {
    const issueList = issues.slice(0, 3).map(i => i.title || 'untitled').join(', ');
    lines.push(`- Active issues: ${issueList}`);
  }

  // Per-file dedupe (newest wins) + drop zones whose absolute path no longer
  // exists on disk — deleted temp files from months ago were still being
  // injected three times per summary. Relative paths skip the existence check
  // (cwd-dependent, can't be judged here).
  const byFile = new Map();
  for (const z of db.getProtectedZones({})) {
    if (path.isAbsolute(z.file) && !fs.existsSync(z.file)) continue;
    const prev = byFile.get(z.file);
    if (!prev || (z.id || 0) > (prev.id || 0)) byFile.set(z.file, z);
  }
  const zones = [...byFile.values()];
  if (zones.length > 0) {
    const zoneList = zones.slice(0, 3).map(z => {
      return `${z.file}${z.reason ? ': ' + z.reason : ''}`;
    }).join('; ');
    lines.push(`- Protected fixes: ${zoneList} — do not modify`);
  }

  const errors = db.getErrorOutputs({ session_id: sessionId, limit: 1 });
  if (errors.length > 0 && errors[0].error_string) {
    const errPreview = errors[0].error_string.substring(0, 100).replace(/\n/g, ' ');
    lines.push(`- Last error: ${errPreview}`);
  }

  const changes = db.getChanges({ session_id: sessionId, limit: 100 });
  if (changes.length > 0) {
    const fileCounts = {};
    for (const c of changes) {
      fileCounts[c.file] = (fileCounts[c.file] || 0) + 1;
    }
    const repeated = Object.entries(fileCounts)
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (repeated.length > 0) {
      const repeatList = repeated.map(([file, count]) => `${file} (${count}x)`).join(', ');
      lines.push(`- Frequently edited: ${repeatList}`);
    }
  }

  if (lines.length === 1) return null;
  return lines.join('\n');
}

function appendEmbeddingInfo(db, sessionId, summary, config) {
  try {
    const { findSimilarPairs } = require('../engine/embedding');
    const { generatePatternLabel } = require('../engine/pattern-label');

    const threshold = (config && config.similarity_threshold) || 0.85;
    const recent = db.getRecentEmbeddings(sessionId, 10);
    if (recent.length < 2) return summary;

    const pairs = findSimilarPairs(
      recent.map(r => ({ id: r.id, buffer: r.description_embedding })),
      threshold
    );
    if (pairs.length < 2) return summary;

    const matchedIds = new Set(pairs.flatMap(p => [p.a, p.b]));
    const changes = db.getChanges({ session_id: sessionId, limit: 20 });
    const descriptions = changes
      .filter(c => matchedIds.has(c.id))
      .map(c => c.description)
      .filter(Boolean);
    const label = generatePatternLabel(descriptions);
    const line = `- Recurring pattern: ${label} (${pairs.length} similar pairs)`;

    return summary ? summary + '\n' + line : 'DevGuard Session Summary:\n' + line;
  } catch (err) {
    debugLog('post-compact', 'Embedding summary failed (non-fatal)', { error: String(err) });
    return summary;
  }
}

function main() {
  const timer = createTimer('post-compact');
  timer.start();

  try {
    const input = readInput();
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());

    const db = getDb(projectPath);
    // Same attribution rule as user-prompt-submit: pin the pending summary to the
    // session that triggered compaction (input.session_id). getLatestSession() is
    // only a fallback — the newest 'sessions' row can be a concurrent headless run.
    const latest = db.getLatestSession();
    const sessionId = input.session_id || (latest && latest.session_id) || null;

    if (!sessionId) {
      debugLog('post-compact', 'No active session, skipping');
      closeDb();
      timer.elapsed('No session');
      respond({});
      return;
    }

    let summary = buildSummary(db, sessionId);

    const { loadConfig } = require('../engine/config');
    const config = loadConfig(projectPath);
    summary = appendEmbeddingInfo(db, sessionId, summary, config);

    if (!summary) {
      debugLog('post-compact', 'No data for summary');
      closeDb();
      timer.elapsed('Empty summary');
      respond({});
      return;
    }

    db.setPendingSummary(sessionId, summary);
    debugLog('post-compact', 'Pending summary saved', { length: summary.length });

    closeDb();
    timer.elapsed('Completed');
    respond({});
  } catch (err) {
    debugLog('post-compact', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

module.exports = { buildSummary, appendEmbeddingInfo };

if (require.main === module) {
  main();
}
