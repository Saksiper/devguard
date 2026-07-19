'use strict';

const { debugLog } = require('./debug-log');

const MAX_TIMELINE_ENTRIES = 5;
const MAX_SNIPPET_LEN = 60;

function truncateSnippet(text, maxLen) {
  if (!text) return null;
  const clean = text.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen);
}

function buildTimeline(changes, errors) {
  try {
    if (!changes || changes.length === 0) return null;

    const errorByChangeId = new Map();
    for (const e of (errors || [])) {
      if (e.change_id && !errorByChangeId.has(e.change_id)) {
        errorByChangeId.set(e.change_id, e);
      }
    }

    const reversed = [...changes].reverse();
    const entries = [];
    for (let i = 0; i < Math.min(reversed.length, MAX_TIMELINE_ENTRIES); i++) {
      const c = reversed[i];
      const desc = truncateSnippet(c.description, MAX_SNIPPET_LEN) || 'edit';
      const err = errorByChangeId.get(c.id);
      const errorText = err ? truncateSnippet(err.error_string, MAX_SNIPPET_LEN) : null;
      entries.push({ file: c.file, description: desc, error: errorText });
    }

    return entries;
  } catch (err) {
    debugLog('context-summarizer', 'buildTimeline failed', { error: String(err) });
    return null;
  }
}

function findDominantFile(changes) {
  try {
    if (!changes || changes.length === 0) return null;

    const fileCounts = {};
    for (const c of changes) {
      fileCounts[c.file] = (fileCounts[c.file] || 0) + 1;
    }
    const sorted = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]);
    const total = changes.length;
    const topFile = sorted[0];
    if (topFile[1] / total >= 0.5) {
      return { file: topFile[0], count: topFile[1], total };
    }
    return null;
  } catch {
    debugLog('context-summarizer', 'findDominantFile failed');
    return null;
  }
}

function findDominantError(errors) {
  try {
    if (!errors || errors.length === 0) return null;

    const hashCounts = {};
    const hashSample = {};
    for (const e of errors) {
      if (!e.error_hash) continue;
      hashCounts[e.error_hash] = (hashCounts[e.error_hash] || 0) + 1;
      if (!hashSample[e.error_hash]) {
        hashSample[e.error_hash] = truncateSnippet(e.error_string, MAX_SNIPPET_LEN) || '?';
      }
    }

    const sorted = Object.entries(hashCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;

    const top = sorted[0];
    return { hash: top[0], count: top[1], preview: hashSample[top[0]] };
  } catch {
    debugLog('context-summarizer', 'findDominantError failed');
    return null;
  }
}

function buildContextSummary(db, sessionId, results, config) {
  if (!results || results.length === 0) return null;

  const threshold = config.context_summary_confidence_threshold ?? 0.6;
  const cycleResults = results.filter(r => r.type !== 'protection');
  if (cycleResults.length === 0) return null;

  const avgConfidence = cycleResults.reduce((s, r) => s + (r.confidence || 0), 0) / cycleResults.length;
  if (avgConfidence < threshold) return null;

  try {
    const changes = db.getChanges({ session_id: sessionId, limit: 50 });
    const errors = db.getErrorOutputs({ session_id: sessionId, limit: 50 });

    const lines = ['Session summary:'];
    lines.push(`Total ${changes.length} changes, ${errors.length} errors in this session.`);

    const timeline = buildTimeline(changes, errors);
    if (timeline && timeline.length > 0) {
      lines.push('');
      lines.push('Approach history (chronological):');
      for (let i = 0; i < timeline.length; i++) {
        const entry = timeline[i];
        const base = `${i + 1}. ${entry.file}: ${entry.description}`;
        if (entry.error) {
          lines.push(base);
          lines.push(`   \u2192 Error: ${entry.error}`);
        } else {
          lines.push(base);
        }
      }
    }

    const observations = [];
    const dominant = findDominantFile(changes);
    if (dominant) {
      observations.push(`${Math.round(dominant.count / dominant.total * 100)}% of all changes are in ${dominant.file}.`);
    }

    const dominantError = findDominantError(errors);
    if (dominantError) {
      observations.push(`Most frequent error (${dominantError.count}x): ${dominantError.preview}`);
    }

    if (observations.length > 0) {
      lines.push('');
      lines.push('Observation: ' + observations.join(' '));
    }

    return lines.join('\n');
  } catch (err) {
    debugLog('context-summarizer', 'buildContextSummary failed', { error: String(err) });
    return null;
  }
}

module.exports = {
  buildContextSummary,
  buildTimeline,
  findDominantFile,
  findDominantError,
};
