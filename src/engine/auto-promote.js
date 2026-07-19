'use strict';

const { debugLog } = require('./debug-log');

function checkAutoPromote(db, config) {
  try {
    const threshold = config.auto_promote_tp_threshold ?? 5;
    const stats = db.getDetectionPatternStats();

    const promotable = [];
    for (const row of stats) {
      if (row.tp_count >= threshold) {
        promotable.push({
          middlewareId: row.middleware_id,
          file: row.file,
          tpCount: row.tp_count,
          fpCount: row.fp_count || 0,
        });
      }
    }

    debugLog('auto-promote', 'Scan complete', { total: stats.length, promotable: promotable.length });
    return promotable;
  } catch (err) {
    debugLog('auto-promote', 'checkAutoPromote failed', { error: String(err) });
    return [];
  }
}

function applyAutoPromote(db, config) {
  try {
    if (!(config.auto_promote_enabled ?? true)) return 0;

    const promotable = checkAutoPromote(db, config);
    if (promotable.length === 0) return 0;

    let promoted = 0;
    for (const p of promotable) {
      const subcategory = p.file ? getSubcategoryFromFile(p.file) : null;
      const existing = db.getThresholdParams(p.middlewareId, subcategory);

      if (existing && existing.sample_count >= p.tpCount + p.fpCount) {
        continue;
      }

      db.upsertThresholdParams(
        p.middlewareId,
        subcategory,
        Math.max(p.tpCount, existing ? existing.alpha : 1.0),
        Math.max(p.fpCount, existing ? existing.beta : 1.0),
        p.tpCount + p.fpCount,
      );
      promoted++;
      debugLog('auto-promote', 'Promoted', {
        middlewareId: p.middlewareId,
        subcategory,
        tpCount: p.tpCount,
        fpCount: p.fpCount,
      });
    }

    return promoted;
  } catch (err) {
    debugLog('auto-promote', 'applyAutoPromote failed', { error: String(err) });
    return 0;
  }
}

function getSubcategoryFromFile(file) {
  if (!file) return null;
  const match = file.match(/\.\w+$/);
  return match ? match[0] : null;
}

module.exports = { checkAutoPromote, applyAutoPromote, getSubcategoryFromFile };
