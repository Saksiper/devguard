'use strict';

const { debugLog } = require('./debug-log');
const { getAdaptiveMinOccurrences, getSubcategory } = require('./adaptive-threshold');

const SKIP = { decision: 'skip', level: 0, type: null, confidence: 0, matches: [], message: '' };

// Split on any run of non-identifier chars (whitespace, punctuation, operators)
// so "this.refillRate)" / "(elapsed" yield bare identifiers and overlap properly.
function tokenize(text) {
  return new Set(text.toLowerCase().split(/[^a-z0-9_$]+/i).filter(Boolean));
}

function jaccardSimilarity(a, b) {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

function makeResult(decision, level, type, confidence, matches, message) {
  return { decision, level, type, confidence, matches, message };
}

function checkErrorHash(db, sessionId, config) {
  if (!sessionId) return SKIP;

  const recent = db.getErrorOutputs({ session_id: sessionId, limit: 1 });
  if (recent.length === 0) return SKIP;

  const hash = recent[0].error_hash;
  if (!hash) return SKIP;

  const all = db.getErrorOutputs({ session_id: sessionId, error_hash: hash });
  const count = all.length;
  debugLog('cycle-detector', 'checkErrorHash', { hash: hash.substring(0, 8), count, sessionId });

  const threshold = config.adaptive_threshold
    ? getAdaptiveMinOccurrences(db, 'cycle:error_hash', getSubcategory('cycle:error_hash', { errorHash: hash }), config.min_occurrences)
    : config.min_occurrences;
  if (count < threshold) return SKIP;

  const confidence = Math.min(count / 5, 1.0);
  const matches = all.map(e => ({ id: e.id, error_hash: e.error_hash, timestamp: e.timestamp }));
  const message = `The same error has occurred ${count} times (hash: ${hash.substring(0, 8)}...).`;

  return makeResult('warn', 1, 'error_hash', confidence, matches, message);
}

function checkDiffMatch(db, oldString, sessionId, config) {
  if (!oldString || !sessionId) return SKIP;

  const recent = db.getChanges({ session_id: sessionId, limit: config.window_size });
  const matches = [];

  for (const change of recent) {
    if (!change.diff_text) continue;
    const similarity = jaccardSimilarity(oldString, change.diff_text);
    if (similarity >= config.similarity_threshold) {
      matches.push({ id: change.id, file: change.file, similarity, timestamp: change.timestamp });
    }
  }

  debugLog('cycle-detector', 'checkDiffMatch', { matchCount: matches.length, windowSize: recent.length });

  const threshold = config.adaptive_threshold
    ? getAdaptiveMinOccurrences(db, 'cycle:diff_match', null, config.min_occurrences)
    : config.min_occurrences;
  if (matches.length < threshold) return SKIP;

  const avgSim = matches.reduce((sum, m) => sum + m.similarity, 0) / matches.length;
  const message = `Similar edit made ${matches.length} times (avg similarity: ${(avgSim * 100).toFixed(0)}%).`;

  return makeResult('warn', 2, 'diff_match', avgSim, matches, message);
}

function checkTestRepeat(db, filePath, sessionId, config) {
  if (!sessionId) return SKIP;

  const recent = db.getErrorOutputs({ session_id: sessionId, limit: config.window_size });
  const testErrors = recent.filter(e => e.test_name && e.test_framework);
  if (testErrors.length === 0) return SKIP;

  const latest = testErrors[0];
  const sameTest = testErrors.filter(e => e.test_name === latest.test_name);
  const count = sameTest.length;

  debugLog('cycle-detector', 'checkTestRepeat', { testName: latest.test_name, count, sessionId });

  const threshold = config.adaptive_threshold
    ? getAdaptiveMinOccurrences(db, 'cycle:test_repeat', getSubcategory('cycle:test_repeat', { testFramework: latest.test_framework }), config.min_occurrences)
    : config.min_occurrences;
  if (count < threshold) return SKIP;

  const confidence = Math.min(count / 5, 1.0);
  const message = `Test "${latest.test_name}" (${latest.test_framework}) has failed ${count} times.`;
  return makeResult('warn', 1, 'test_repeat', confidence, sameTest.map(e => ({ id: e.id, test_name: e.test_name, timestamp: e.timestamp })), message);
}

module.exports = { checkErrorHash, checkDiffMatch, checkTestRepeat, jaccardSimilarity };
