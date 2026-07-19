'use strict';

const { debugLog } = require('./debug-log');
const { buildContextSummary } = require('./context-summarizer');

const MAX_DESC_LEN = 80;
const MAX_ERROR_LEN = 150;
const MAX_MESSAGE_LEN = 1500;

function truncate(text, maxLen) {
  if (!text) return null;
  const clean = text.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen);
}

function formatTime(timestamp) {
  if (!timestamp) return '?';
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '?';
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    return '?';
  }
}

function buildErrorHashSection(db, sessionId, result) {
  try {
    const matches = result.matches || [];
    if (matches.length === 0) return result.message;

    const firstHash = matches[0].error_hash;
    const errors = db.getErrorOutputs({ session_id: sessionId, error_hash: firstHash, limit: 5 });
    if (errors.length === 0) return result.message;

    const errorPreview = truncate(errors[0].error_string, MAX_ERROR_LEN) || 'unknown error';
    const lines = [`Recurring error:`];
    lines.push(`This error (${errorPreview}) occurred ${matches.length} times.`);

    const changeIds = [];
    for (const e of errors) {
      if (e.change_id) changeIds.push(e.change_id);
    }
    if (changeIds.length > 0) {
      const changes = db.getChangesByIds(changeIds);
      const changeMap = new Map(changes.map(c => [c.id, c]));
      for (let i = 0; i < Math.min(errors.length, 3); i++) {
        const e = errors[i];
        const c = e.change_id ? changeMap.get(e.change_id) : null;
        const desc = c ? (truncate(c.claude_verdict || c.description, MAX_DESC_LEN) || c.file) : 'edit (no detail)';
        lines.push(`Attempt ${i + 1}: ${desc}`);
      }
    }

    lines.push('Same approach has not worked. The root cause may be different.');
    return lines.join('\n');
  } catch (err) {
    debugLog('message-builder', 'buildErrorHashSection failed', { error: String(err) });
    return result.message;
  }
}

function buildDiffMatchSection(db, sessionId, result) {
  try {
    const matches = result.matches || [];
    if (matches.length === 0) return result.message;

    const ids = matches.map(m => m.id).filter(Boolean);
    const changes = ids.length > 0 ? db.getChangesByIds(ids) : [];
    const changeMap = new Map(changes.map(c => [c.id, c]));

    const lines = [`Similar changes:`];
    lines.push(`${matches.length} similar edits attempted:`);
    for (let i = 0; i < Math.min(matches.length, 3); i++) {
      const m = matches[i];
      const c = changeMap.get(m.id);
      const file = m.file || (c && c.file) || '?';
      const desc = c ? (truncate(c.claude_verdict || c.description, 60) || 'edit (no detail)') : 'edit (no detail)';
      const sim = m.similarity ? ` (%${(m.similarity * 100).toFixed(0)})` : '';
      lines.push(`(${i + 1}) ${file} — ${desc}${sim}`);
    }
    return lines.join('\n');
  } catch (err) {
    debugLog('message-builder', 'buildDiffMatchSection failed', { error: String(err) });
    return result.message;
  }
}

function buildTestRepeatSection(db, sessionId, result) {
  try {
    const matches = result.matches || [];
    if (matches.length === 0) return result.message;

    const ids = matches.map(m => m.id).filter(Boolean);
    const errors = ids.length > 0 ? db.getErrorsByIds(ids) : [];
    const errorMap = new Map(errors.map(e => [e.id, e]));

    const testName = matches[0].test_name || '?';
    const framework = errors.length > 0 && errors[0].test_framework ? errors[0].test_framework : '?';

    const lines = [`Test failure (${testName}, ${framework}):`];
    lines.push(`${matches.length} failures:`);
    for (let i = 0; i < Math.min(matches.length, 3); i++) {
      const m = matches[i];
      const e = errorMap.get(m.id);
      const errText = e ? (truncate(e.error_string, 100) || 'no error detail') : 'no error detail';
      lines.push(`(${i + 1}) ${formatTime(m.timestamp)} — ${errText}`);
    }
    return lines.join('\n');
  } catch (err) {
    debugLog('message-builder', 'buildTestRepeatSection failed', { error: String(err) });
    return result.message;
  }
}

function buildEmbeddingSection(db, sessionId, result) {
  try {
    const matches = result.matches || [];
    if (matches.length === 0) return result.message;

    const allIds = new Set();
    for (const p of matches) {
      if (p.a) allIds.add(p.a);
      if (p.b) allIds.add(p.b);
    }
    const changes = db.getChangesByIds([...allIds]);
    const changeMap = new Map(changes.map(c => [c.id, c]));

    const lines = [`Semantic similarity:`];
    lines.push('Repeating semantically similar changes:');
    for (let i = 0; i < Math.min(matches.length, 2); i++) {
      const p = matches[i];
      const ca = changeMap.get(p.a);
      const cb = changeMap.get(p.b);
      const descA = ca ? (truncate(ca.claude_verdict || ca.description, 40) || '?') : '?';
      const descB = cb ? (truncate(cb.claude_verdict || cb.description, 40) || '?') : '?';
      const sim = p.similarity ? `%${(p.similarity * 100).toFixed(0)}` : '';
      lines.push(`- ${descA} ↔ ${descB} (${sim})`);
    }
    return lines.join('\n');
  } catch (err) {
    debugLog('message-builder', 'buildEmbeddingSection failed', { error: String(err) });
    return result.message;
  }
}

function buildProtectionSection(db, sessionId, result) {
  try {
    const zones = result.matches || [];
    if (zones.length === 0) return result.message;

    const zone = zones[0];
    const lines = [];

    const reason = zone.reason || '';
    const commit = zone.protected_commit ? ` (${zone.protected_commit.substring(0, 7)})` : '';
    lines.push(`WARNING: These lines were added for the "${reason}"${commit} fix.`);

    if (zone.change_id) {
      const change = db.getChangeById(zone.change_id);
      if (change && (change.claude_verdict || change.description)) {
        const desc = truncate(change.claude_verdict || change.description, 100);
        lines.push(`Original fix: ${desc}`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    debugLog('message-builder', 'buildProtectionSection failed', { error: String(err) });
    return result.message;
  }
}

const SECTION_BUILDERS = {
  error_hash: buildErrorHashSection,
  diff_match: buildDiffMatchSection,
  test_repeat: buildTestRepeatSection,
  embedding_match: buildEmbeddingSection,
  protection: buildProtectionSection,
};

// Single source of truth for the DG-tag directive block. Both buildRichMessage
// and pre-edit's formatMessage fallback route through this so the wording never
// drifts (the fallback only runs if buildRichMessage returns null, which no
// non-empty result type currently does). The first line IS the CTA_MARKER, so in
// buildRichMessage — the only path that enforces MAX_MESSAGE_LEN — the whole
// directive lands in the never-truncated tail. formatMessage applies NO cap; it is
// interchangeable only because it runs on already-short messages.
function buildDirectiveBlock(hasProtection) {
  const lines = [
    '\nREQUIRED: Start your next reply with exactly one of these tags:',
    '  [DG-CONTINUE] <one-sentence reason this approach will work>',
    '  [DG-PIVOT] <one-sentence reason you will change approach>',
    '  [DG-PAUSE] <one-sentence reason you need to investigate first>',
  ];
  if (hasProtection) {
    lines.push('If you choose CONTINUE on a protection warning, you must preserve the existing fix.');
  }
  return lines;
}

function buildRichMessage(db, sessionId, results, finalDecision, pickCognitiveLabel, pickChallengeQuestion, recentLabels, config) {
  if (!results || results.length === 0) return null;

  const hasProtection = results.some(r => r.type === 'protection');
  const header = "I'm DevGuard, a secondary protection mechanism set up by the user.\n\nI noticed the following:";

  const sections = [header];

  for (const r of results) {
    const builder = SECTION_BUILDERS[r.type];
    if (builder) {
      const section = builder(db, sessionId, r);
      sections.push('- ' + section);
    } else {
      sections.push('- ' + r.message);
    }
  }

  if (typeof pickCognitiveLabel === 'function') {
    const label = pickCognitiveLabel(results, recentLabels);
    if (label) sections.push('- ' + label);
  }

  if (typeof pickChallengeQuestion === 'function') {
    const question = pickChallengeQuestion(results);
    if (question) sections.push('- ' + question);
  }

  // Context summary BEFORE the directive: when over budget the CTA tail is kept
  // verbatim, so anything after the marker would survive truncation at the
  // expense of the detection sections. Placing the boilerplate summary in the
  // pre-CTA region makes it the FIRST thing the budget cuts.
  try {
    if (config && (config.context_summary_enabled !== false)) {
      const summary = buildContextSummary(db, sessionId, results, config);
      if (summary) sections.push('\n' + summary);
    }
  } catch (err) {
    debugLog('message-builder', 'Context summary failed', { error: String(err) });
  }

  for (const line of buildDirectiveBlock(hasProtection)) sections.push(line);

  const CTA_MARKER = '\nREQUIRED: Start your next reply';
  let message = sections.join('\n');
  if (message.length > MAX_MESSAGE_LEN) {
    const ctaIdx = message.indexOf(CTA_MARKER);
    if (ctaIdx > 0) {
      // Priority when over budget: keep the full CTA intact (tag-compliance
      // depends on it), then as much of the detection sections as still fits.
      const cta = message.substring(ctaIdx);
      const pre = message.substring(0, ctaIdx);
      const preBudget = Math.max(0, MAX_MESSAGE_LEN - cta.length);
      message = pre.slice(0, preBudget) + cta;
    } else {
      message = message.substring(0, MAX_MESSAGE_LEN);
    }
  }

  return message;
}

module.exports = {
  buildRichMessage,
  buildDirectiveBlock,
  buildErrorHashSection,
  buildDiffMatchSection,
  buildTestRepeatSection,
  buildEmbeddingSection,
  buildProtectionSection,
  truncate,
  formatTime,
  MAX_DESC_LEN,
  MAX_ERROR_LEN,
  MAX_MESSAGE_LEN,
};
