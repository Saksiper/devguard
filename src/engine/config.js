'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

let debugLog;
try { debugLog = require('./debug-log').debugLog; } catch { debugLog = () => {}; }

const DEFAULTS = {
  similarity_threshold: 0.70,
  embedding_similarity_threshold: 0.85,
  // Calibrated FLOOR on real MiniLM (2026-07): distinct-feature inter-cosine peaked at
  // 0.265, so 0.28 preserves separation (0 false merges on the 30-sample fixture) while
  // capturing intra-feature cohesion. The margin is thin and fixture-bound — re-validate
  // (contamination-vs-fragmentation sweep) as the corpus grows. Grain is ultimately owned
  // by S3 [DG-NOTE] markers, so a mis-cluster here is a soft, self-correcting default.
  feature_cluster_threshold: 0.28,
  window_size: 10,
  min_occurrences: 2,
  max_entries: 10000,
  periodic_injection_interval: 20,
  embedding_enabled: true,
  embedding_detector_enabled: false,
  // S2.B: use the embedding read-resolver (prompt→centroid argmax) instead of the
  // keyword map in UserPromptSubmit. DEFAULT-OFF: enabling it loads MiniLM on EVERY
  // prompt turn (synchronous latency). Stays OFF until an N>=20 live measurement.
  sphere_read_resolver_enabled: false,
  // S2.A per-project keyword read-index: model-free prompt->node resolution over the
  // project's own notes, DEFAULT-ON (~0ms). Surfaces only on a CONFIDENT match; the
  // ambiguous tail defers to the embedding resolver (if enabled). keyword_index_margin
  // is the runner-up/top ratio above which a match is "too close to call" -> defer
  // (measured clean gap 0.58..1.0 on the ALES sphere, so 0.75 is well inside it).
  keyword_index_enabled: true,
  keyword_index_margin: 0.75,
  // A/B effectiveness toggle. true (default) = active: measure AND inject (current
  // behavior, byte-identical). false = passive: still MEASURE everything (detections,
  // node_ids, notes are recorded by post-edit and detection_log) but inject NOTHING to
  // Claude — no pre-edit warnings, no sphere note surfacing. Control arm for measuring
  // DevGuard's real effect.
  intervention_enabled: true,
  context_summary_enabled: true,
  context_summary_confidence_threshold: 0.6,
  adaptive_threshold: true,
  auto_promote_enabled: true,
  auto_promote_tp_threshold: 5,
  detection_cooldown_edits: 3,
  excluded_path_segments: [
    '/.claude/',
    '/.superpowers/',
    '/node_modules/',
    '/.git/',
    '/dist/',
    '/build/',
    '/coverage/',
    '/.next/',
    '/.cache/',
  ],
  excluded_basenames: ['MEMORY.md'],
  monitor_enabled: true,
  monitor_interval: 30,
  monitor_velocity_threshold: 5,
  monitor_fatigue_threshold: 50,
  // Orphan-backstop staleness: on SessionStart, prior sessions whose last activity
  // is older than this many hours are presumed dead and their surfaced-but-unacked
  // notes are finalized as 'lapsed'. Conservative default — this is the ONLY guard
  // against finalizing a still-open, idle parallel terminal (too short → a legit late
  // ack on an idle session is lost; too long → measurement completeness lags).
  finalize_stale_after_hours: 6,
};

const VALIDATORS = {
  similarity_threshold: (v) => typeof v === 'number' && v >= 0.0 && v <= 1.0,
  embedding_similarity_threshold: (v) => typeof v === 'number' && v >= 0.0 && v <= 1.0,
  feature_cluster_threshold: (v) => typeof v === 'number' && v >= 0.0 && v <= 1.0,
  window_size: (v) => Number.isInteger(v) && v > 0,
  min_occurrences: (v) => Number.isInteger(v) && v > 0,
  max_entries: (v) => Number.isInteger(v) && v > 0,
  periodic_injection_interval: (v) => Number.isInteger(v) && v >= 0,
  embedding_enabled: (v) => typeof v === 'boolean',
  embedding_detector_enabled: (v) => typeof v === 'boolean',
  sphere_read_resolver_enabled: (v) => typeof v === 'boolean',
  keyword_index_enabled: (v) => typeof v === 'boolean',
  keyword_index_margin: (v) => typeof v === 'number' && v > 0 && v <= 1,
  intervention_enabled: (v) => typeof v === 'boolean',
  context_summary_enabled: (v) => typeof v === 'boolean',
  context_summary_confidence_threshold: (v) => typeof v === 'number' && v >= 0.0 && v <= 1.0,
  adaptive_threshold: (v) => typeof v === 'boolean',
  auto_promote_enabled: (v) => typeof v === 'boolean',
  auto_promote_tp_threshold: (v) => Number.isInteger(v) && v > 0,
  detection_cooldown_edits: (v) => Number.isInteger(v) && v >= 0,
  excluded_path_segments: (v) => Array.isArray(v) && v.every(x => typeof x === 'string'),
  excluded_basenames: (v) => Array.isArray(v) && v.every(x => typeof x === 'string'),
  monitor_enabled: (v) => typeof v === 'boolean',
  monitor_interval: (v) => Number.isInteger(v) && v >= 10 && v <= 300,
  monitor_velocity_threshold: (v) => Number.isInteger(v) && v >= 3 && v <= 20,
  monitor_fatigue_threshold: (v) => Number.isInteger(v) && v >= 20,
  finalize_stale_after_hours: (v) => typeof v === 'number' && v > 0,
};

function findConfigFile(projectPath) {
  let current = projectPath;
  while (true) {
    const candidate = path.join(current, 'devguard.config.yaml');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function loadConfig(projectPath) {
  const configPath = findConfigFile(projectPath);

  if (!configPath) {
    return Object.assign({}, DEFAULTS);
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    debugLog('config', 'Failed to read config file', { path: configPath, error: String(err) });
    return Object.assign({}, DEFAULTS);
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    debugLog('config', 'Failed to parse YAML config', { path: configPath, error: String(err) });
    return Object.assign({}, DEFAULTS);
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return Object.assign({}, DEFAULTS);
  }

  const result = Object.assign({}, DEFAULTS);

  for (const key of Object.keys(VALIDATORS)) {
    if (!(key in parsed)) {
      continue;
    }
    const value = parsed[key];
    if (VALIDATORS[key](value)) {
      result[key] = value;
    } else {
      debugLog('config', `Invalid value for ${key}, using default`, { value, default: DEFAULTS[key] });
    }
  }

  return result;
}

module.exports = { loadConfig, DEFAULTS };
