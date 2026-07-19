'use strict';

const { readInput, respond } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');

function buildSummary(db, sessionId) {
  const lines = ['DevGuard Session Summary:'];

  const issues = db.getIssues({ status: 'open' });
  if (issues.length > 0) {
    const issueList = issues.slice(0, 3).map(i => i.title || 'untitled').join(', ');
    lines.push(`- Active issues: ${issueList}`);
  }

  const zones = db.getProtectedZones({});
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
