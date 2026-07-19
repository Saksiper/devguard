'use strict';

// Note-compliance markdown section shared by the stats and dogfood CLIs (S4.4).
// Consumes db.getNoteComplianceStats (S4.3) plus a layer-depth pass over db.getNotes.
// project_path scoping is handled inside the db proxy; opts.session_id narrows both.
// Returns [] when there is nothing to report so callers can conditionally append.
function buildComplianceSection(db, opts = {}) {
  const filter = {};
  if (opts.session_id) filter.session_id = opts.session_id;

  const stats = db.getNoteComplianceStats(filter);
  const avgLayerDepth = computeAvgLayerDepth(db, filter);
  if (stats.total === 0 && avgLayerDepth === null) return [];

  const lines = ['### Note Compliance (sphere)'];

  // No compliance events at all (notes placed but nothing surfaced/decided): a
  // zero-valued rate table reads as "guidance ignored" when the truth is "not
  // measured yet". Emit only the real datum (layer depth) plus an explicit note.
  if (stats.total === 0) {
    lines.push('_No compliance events yet._');
    if (avgLayerDepth !== null) {
      lines.push('| Metric | Value |', '|--------|-------|', `| Avg layer depth | ${avgLayerDepth.toFixed(2)} |`);
    }
    lines.push('');
    return lines;
  }

  const pct = x => (x * 100).toFixed(1) + '%';
  // Compliance is measured only over DECIDED events (complied + ignored). With none
  // decided, the rate is "not measured yet" (—), never 0% — the latter falsely reads
  // as "every note ignored". compliance_of_surfaced shares the same denominator gate:
  // complied ⊆ decided, so decided===0 ⟹ complied===0 ⟹ that rate is undefined too.
  const decided = stats.complied + stats.ignored;
  const rateCell = decided > 0 ? pct(stats.compliance) : '—';
  const surfacedCell = decided > 0 ? pct(stats.compliance_of_surfaced) : '—';
  lines.push(
    '| Metric | Value |',
    '|--------|-------|',
    `| Compliance rate | ${rateCell} |`,
    `| Complied | ${stats.complied} |`,
    `| Ignored | ${stats.ignored} |`,
    `| Superseded | ${stats.superseded} |`,
    `| Lapsed | ${stats.lapsed} |`,
    `| Surfaced | ${stats.surfaced} |`,
    `| Complied of surfaced | ${surfacedCell} |`,
  );
  if (avgLayerDepth !== null) lines.push(`| Avg layer depth | ${avgLayerDepth.toFixed(2)} |`);
  lines.push('');
  return lines;
}

// Mean number of layered notes per feature node. null when no node-scoped notes
// exist, so the row is omitted rather than reporting a meaningless 0.00.
function computeAvgLayerDepth(db, filter) {
  const notes = db.getNotes({ ...filter, limit: 10000 });
  const perNode = {};
  for (const n of notes) {
    if (!n.node_id) continue;
    perNode[n.node_id] = (perNode[n.node_id] || 0) + 1;
  }
  const nodes = Object.keys(perNode);
  if (nodes.length === 0) return null;
  return nodes.reduce((s, k) => s + perNode[k], 0) / nodes.length;
}

module.exports = { buildComplianceSection, computeAvgLayerDepth };
