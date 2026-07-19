'use strict';

const { debugLog } = require('./debug-log');

const MIN_SAMPLE_COUNT = 5;
const MIN_THRESHOLD = 2;

function betaSample(alpha, beta) {
  // Jöhnk's algorithm for Beta distribution sampling
  // Simplified: use mean approximation for production stability
  // Mean of Beta(a,b) = a / (a+b)
  // Add small random perturbation for Thompson Sampling exploration
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const stddev = Math.sqrt(variance);

  // Box-Muller transform for normal random
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, mean + z * stddev));
}

function getSubcategory(middlewareId, context) {
  if (!context) return null;
  switch (middlewareId) {
    case 'cycle:error_hash': {
      return context.errorHash ? context.errorHash.substring(0, 4) : null;
    }
    case 'cycle:test_repeat': {
      return context.testFramework || null;
    }
    default:
      return null;
  }
}

function getAdaptiveMinOccurrences(db, middlewareId, subcategory, staticDefault) {
  try {
    const params = db.getThresholdParams(middlewareId, subcategory);
    if (!params || params.sample_count < MIN_SAMPLE_COUNT) {
      return staticDefault;
    }

    const sample = betaSample(params.alpha, params.beta);
    debugLog('adaptive-threshold', 'Thompson sample', {
      middlewareId, subcategory, alpha: params.alpha, beta: params.beta, sample,
    });

    if (sample > 0.5) {
      return Math.max(MIN_THRESHOLD, staticDefault - 1);
    }
    return staticDefault + 1;
  } catch (err) {
    debugLog('adaptive-threshold', 'Fallback to static', { error: String(err) });
    return staticDefault;
  }
}

function updateThreshold(db, middlewareId, subcategory, isTP) {
  try {
    const params = db.getThresholdParams(middlewareId, subcategory);
    let alpha = params ? params.alpha : 1.0;
    let beta = params ? params.beta : 1.0;
    let sampleCount = params ? params.sample_count : 0;

    if (isTP) {
      alpha += 1;
    } else {
      beta += 1;
    }
    sampleCount += 1;

    db.upsertThresholdParams(middlewareId, subcategory, alpha, beta, sampleCount);
    debugLog('adaptive-threshold', 'Updated', { middlewareId, subcategory, alpha, beta, sampleCount, isTP });
  } catch (err) {
    debugLog('adaptive-threshold', 'Update failed', { error: String(err) });
  }
}

module.exports = {
  getAdaptiveMinOccurrences,
  updateThreshold,
  getSubcategory,
  betaSample,
  MIN_SAMPLE_COUNT,
  MIN_THRESHOLD,
};
