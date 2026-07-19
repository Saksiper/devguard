'use strict';

const { readInput, respond, context } = require('../engine/hook-io');
const { debugLog, createTimer } = require('../engine/debug-log');
const { getDb, closeDb } = require('../engine/db');
const { loadConfig } = require('../engine/config');
const { checkErrorHash, checkDiffMatch, checkTestRepeat } = require('../engine/cycle-detector');
const { resolveLines } = require('../engine/line-resolver');
const { hasProtectedCommit, checkProtection } = require('../engine/protection');
const { normalizePath } = require('../engine/normalize-path');
const { buildRichMessage, buildDirectiveBlock } = require('../engine/message-builder');
const { buildSummary } = require('./post-compact');

const SKIP = { decision: 'skip' };

// A/B intervention gate. Active (default) → inject the message as PreToolUse context.
// Passive (intervention_enabled=false) → inject NOTHING (respond({})). Every Claude-facing
// injection site routes through here so passive mode is provably injection-free while all
// measurement upstream (pipeline, insertDetection, pending consume) still runs.
function emit(config, msg) {
  if (config.intervention_enabled) {
    context(msg, 'PreToolUse');
  } else {
    respond({});
  }
}

function getActiveIssueId(db) {
  try {
    return db.getLastOpenIssueId();
  } catch {
    return null;
  }
}

function runPipeline(ctx, middlewares) {
  const results = [];
  for (const mw of middlewares) {
    try {
      const result = mw.fn(ctx);
      if (result && result.decision !== 'skip') {
        result.middlewareId = mw.id;
        results.push(result);
      }
    } catch (err) {
      debugLog('pipeline', 'Middleware error, skipping', { id: mw.id, error: String(err) });
    }
  }
  return results;
}

function errorHashMiddleware(ctx) {
  return checkErrorHash(ctx.db, ctx.sessionId, ctx.config);
}

function diffMatchMiddleware(ctx) {
  return checkDiffMatch(ctx.db, ctx.oldString, ctx.sessionId, ctx.config);
}

function testRepeatMiddleware(ctx) {
  return checkTestRepeat(ctx.db, ctx.filePath, ctx.sessionId, ctx.config);
}

function makeResult(decision, level, type, confidence, matches, message) {
  return { decision, level, type, confidence, matches, message };
}

function embeddingMiddleware(ctx) {
  if (!ctx.config.embedding_detector_enabled) return SKIP;
  if (!ctx.config.embedding_enabled) return SKIP;

  const recent = ctx.db.getRecentEmbeddings(ctx.sessionId, ctx.config.window_size);
  if (recent.length < 2) return SKIP;

  const { findSimilarPairs } = require('../engine/embedding');
  // A cycle is rework of the same target. Cross-file similarity during feature
  // work is shared project vocabulary, not a loop — 21/21 FP warns (2026-06-04)
  // were cross-file pairs at the shared 0.70 threshold, so pairs are scoped to
  // the same file and use a stricter embedding-specific threshold.
  const threshold = ctx.config.embedding_similarity_threshold ?? ctx.config.similarity_threshold;
  const byFile = new Map();
  for (const r of recent) {
    const group = byFile.get(r.file) || [];
    group.push({ id: r.id, buffer: r.description_embedding });
    byFile.set(r.file, group);
  }
  let pairs = [];
  for (const group of byFile.values()) {
    if (group.length >= 2) pairs = pairs.concat(findSimilarPairs(group, threshold));
  }

  if (pairs.length < ctx.config.min_occurrences) return SKIP;

  const avgSim = pairs.reduce((s, p) => s + p.similarity, 0) / pairs.length;
  const message = `Semantic similarity: ${pairs.length} similar pairs in last ${recent.length} changes (avg ${(avgSim * 100).toFixed(0)}%).`;

  return makeResult('warn', 3, 'embedding_match', avgSim, pairs, message);
}

function protectionMiddleware(ctx) {
  if (!ctx.lineRanges || ctx.lineRanges.length === 0) return SKIP;
  if (!hasProtectedCommit(ctx.db, ctx.filePath)) return SKIP;

  const activeIssueId = getActiveIssueId(ctx.db);
  const result = checkProtection(ctx.db, ctx.filePath, ctx.lineRanges, ctx.projectPath, activeIssueId);
  if (!result || !result.hit) return SKIP;

  return {
    decision: 'warn',
    level: 0,
    type: 'protection',
    confidence: 1.0,
    matches: result.zones,
    message: result.message,
  };
}

const MIDDLEWARES = [
  { id: 'cycle:error_hash', fn: errorHashMiddleware },
  { id: 'cycle:diff_match', fn: diffMatchMiddleware },
  { id: 'cycle:test_repeat', fn: testRepeatMiddleware },
  { id: 'cycle:embedding', fn: embeddingMiddleware },
  { id: 'protect:check', fn: protectionMiddleware },
];

const COGNITIVE_LABELS = {
  anchoring: 'You may be anchored to your initial hypothesis.',
  sunk_cost: 'Previous attempts would have worked if they were correct.',
  independence: 'Small variations are unlikely to produce different results.',
  framing_effect: 'Question the assumption that your approach is correct.',
};

const CHALLENGE_QUESTIONS = {
  error_hash: 'What could be the root cause of this error?',
  diff_match: 'Why would the same approach work this time?',
  embedding_match: 'Have you tried a semantically different strategy?',
  test_repeat: 'Why is the test failing? Is the issue in the test or the code?',
};

function pickCognitiveLabel(results, recentLabels) {
  const hasErrorHash = results.some(r => r.type === 'error_hash');
  const hasDiffMatch = results.some(r => r.type === 'diff_match');
  const hasEmbeddingMatch = results.some(r => r.type === 'embedding_match');
  const multipleSignals = results.filter(r => r.type !== 'protection').length >= 2;

  const preferred = [];
  if (hasEmbeddingMatch) preferred.push('independence');
  if (hasDiffMatch && hasErrorHash) preferred.push('independence');
  if (hasErrorHash && multipleSignals) preferred.push('anchoring');
  if (hasDiffMatch && multipleSignals) preferred.push('sunk_cost');
  if (multipleSignals) preferred.push('framing_effect');

  if (preferred.length === 0) return null;

  const recent = recentLabels || [];
  const isUsed = (key) => recent.some(r => r && COGNITIVE_LABELS[key] && r.includes(COGNITIVE_LABELS[key]));
  const available = preferred.filter(key => !isUsed(key));
  let chosenKey;
  if (available.length > 0) {
    chosenKey = available[0];
  } else {
    const allKeys = Object.keys(COGNITIVE_LABELS);
    const fresh = allKeys.filter(key => !isUsed(key));
    chosenKey = fresh.length > 0 ? fresh[0] : preferred[0];
  }
  return COGNITIVE_LABELS[chosenKey] || null;
}

function pickChallengeQuestion(results) {
  const sorted = results
    .filter(r => r.type !== 'protection' && CHALLENGE_QUESTIONS[r.type])
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  if (sorted.length === 0) return null;
  return CHALLENGE_QUESTIONS[sorted[0].type];
}

function formatMessage(results, _finalDecision, recentLabels) {
  const hasProtection = results.some(r => r.type === 'protection');

  const lines = ["I'm DevGuard, a secondary protection mechanism set up by the user.\n\nI noticed the following:"];
  for (const r of results) {
    lines.push('- ' + r.message);
  }

  const label = pickCognitiveLabel(results, recentLabels);
  if (label) {
    lines.push('- ' + label);
  }

  const question = pickChallengeQuestion(results);
  if (question) {
    lines.push('- ' + question);
  }

  for (const line of buildDirectiveBlock(hasProtection)) lines.push(line);

  return lines.join('\n');
}

function checkPeriodicInjection(db, session, config) {
  const interval = config.periodic_injection_interval ?? 20;
  if (interval === 0) return null;
  const lastId = session.last_injection_change_id || 0;
  const count = db.getChangeCountSince(session.session_id, lastId);
  if (count < interval) return null;

  const summary = buildSummary(db, session.session_id);
  if (!summary) return null;

  const currentMaxId = db.getMaxChangeId(session.session_id);
  db.updateLastInjectionChangeId(session.session_id, currentMaxId);
  debugLog('pre-edit', 'Periodic injection triggered', { count, interval, currentMaxId });
  return summary;
}

function main() {
  const timer = createTimer('pre-edit');
  timer.start();

  try {
    const input = readInput();
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(input.cwd || process.cwd());
    const toolInput = input.tool_input || {};
    const filePath = normalizePath(toolInput.file_path || '') || '';
    const oldString = toolInput.old_string || '';

    if (!filePath) {
      timer.elapsed('No file_path, allowing');
      respond({});
      return;
    }

    // Path exclusion — skip DB entirely for excluded paths (.claude/, node_modules/, etc.)
    const config = loadConfig(projectPath);
    const { isExcluded } = require('../engine/path-matcher');
    if (isExcluded(filePath, config)) {
      debugLog('pre-edit', 'Path excluded', { file: filePath });
      timer.elapsed('Path excluded');
      respond({});
      return;
    }

    const db = getDb(projectPath);
    // g2: use the session that made THIS edit — resolve the payload session_id
    // to its row first (checkPeriodicInjection needs the full row);
    // getLatestSession() only as fallback for older clients.
    const session = (input.session_id && db.getSessionById(input.session_id))
      || db.getLatestSession();

    if (!session) {
      debugLog('pre-edit', 'No active session, allowing');
      closeDb();
      timer.elapsed('No session');
      respond({});
      return;
    }

    let pendingSummary = null;
    try {
      pendingSummary = db.consumePendingSummary(session.session_id);
    } catch { /* non-fatal */ }

    const lineRanges = resolveLines(filePath, oldString);
    const ctx = {
      db,
      filePath,
      oldString,
      sessionId: session.session_id,
      config,
      projectPath,
      lineRanges,
    };

    let results = runPipeline(ctx, MIDDLEWARES);

    // Cooldown dedupe: suppress duplicate warns for (file, middleware) within the
    // last N change events. Protection is exempt (never suppressed).
    const cooldownN = config.detection_cooldown_edits ?? 3;
    if (cooldownN > 0 && results.length > 0) {
      results = results.filter(r => {
        if (r.type === 'protection') return true; // hard guard — protection never suppressed
        if (!r.middlewareId) return true;
        try {
          const suppressed = db.hasRecentDetectionForFile(
            session.session_id, filePath, r.middlewareId, cooldownN
          );
          if (suppressed) {
            debugLog('pre-edit', 'Cooldown suppressed', {
              file: filePath, mw: r.middlewareId, n: cooldownN,
            });
            return false;
          }
        } catch { /* non-fatal */ }
        return true;
      });
    }

    const cycleResults = results.filter(r => r.type !== 'protection');
    const finalDecision = cycleResults.length > 0 ? 'warn' : 'none';

    // detection_log: record each warn (dogfood measurement, removable).
    try {
      for (const r of results) {
        if (r.decision === 'warn') {
          db.insertDetection({
            session_id: session.session_id,
            file: filePath,
            middleware_id: r.middlewareId || null,
            decision: r.decision,
            level: r.level,
            type: r.type,
            confidence: r.confidence,
            message: r.message,
          });
        }
      }
    } catch { /* non-fatal, table may not exist */ }

    if (results.length === 0 && !pendingSummary) {
      const periodicSummary = checkPeriodicInjection(db, session, config);
      closeDb();
      if (periodicSummary) {
        timer.elapsed('Periodic injection');
        emit(config, periodicSummary);
      } else {
        timer.elapsed('No cycle detected');
        respond({});
      }
      return;
    }

    if (results.length === 0 && pendingSummary) {
      closeDb();
      timer.elapsed('Injecting pending summary only');
      emit(config, pendingSummary);
      return;
    }

    let recentLabels = [];
    try {
      recentLabels = db.getRecentDetectionMessages(session.session_id, 3);
    } catch { /* non-fatal */ }

    let message = buildRichMessage(db, session.session_id, results, finalDecision, pickCognitiveLabel, pickChallengeQuestion, recentLabels, config);
    if (!message) message = formatMessage(results, finalDecision, recentLabels);
    if (!message) message = 'DevGuard: detection signal present.';

    closeDb();
    if (pendingSummary) {
      message = pendingSummary + '\n\n' + message;
    }

    timer.elapsed('Cycle warned');
    emit(config, message);
  } catch (err) {
    debugLog('pre-edit', 'Error caught, failing gracefully', { error: String(err) });
    try { closeDb(); } catch { /* graceful */ }
    respond({});
  }
}

module.exports = { runPipeline, formatMessage, pickCognitiveLabel, pickChallengeQuestion, MIDDLEWARES, checkPeriodicInjection, embeddingMiddleware, CHALLENGE_QUESTIONS };

if (require.main === module) {
  main();
}
