'use strict';

// Merge multiple A/B harness report JSONs into one: concatenate pairs and
// recompute the summary with the SAME computeSummary the harness uses, so a
// merged report can never disagree with a fresh run over the same pairs.
// Merging is only valid across batches that ran the same run/judge models and
// unchanged task definitions — model mismatches throw loudly (a silently mixed
// report would misattribute quality differences to the intervention).
//
// Usage: node tools/dg-ab-merge.js <report1.json> <report2.json> [...] -o <out.json>

const fs = require('fs');
const path = require('path');
const { computeSummary } = require('./dg-ab-harness');

function mergeReports(reports, sourceNames) {
  if (!reports || reports.length < 2) throw new Error('[ab-merge] need at least 2 reports to merge');
  const first = reports[0];
  for (let i = 1; i < reports.length; i++) {
    const m = reports[i].meta || {};
    const f = first.meta || {};
    if (m.run_model !== f.run_model || m.judge_model !== f.judge_model) {
      throw new Error(`[ab-merge] model mismatch: ${sourceNames[i]} ran ${m.run_model}/${m.judge_model}, ${sourceNames[0]} ran ${f.run_model}/${f.judge_model} — merged batches must share models`);
    }
  }
  const pairs = reports.flatMap((r) => r.pairs || []);
  return {
    meta: {
      ...first.meta,
      merged_from: sourceNames.map((name, i) => ({
        file: name,
        n_pairs: (reports[i].pairs || []).length,
      })),
      merge_note: 'Merged offline from the batches in merged_from; pairs concatenated, summary recomputed via the harness computeSummary. Valid only because every batch shares run/judge models and unchanged task definitions.',
    },
    generated_at: new Date().toISOString(),
    n_pairs: pairs.length,
    pairs,
    summary: computeSummary(pairs),
  };
}

function main() {
  const args = process.argv.slice(2);
  const oIdx = args.indexOf('-o');
  if (oIdx === -1 || !args[oIdx + 1] || args.filter((a, i) => i !== oIdx && i !== oIdx + 1).length < 2) {
    console.error('Usage: node tools/dg-ab-merge.js <report1.json> <report2.json> [...] -o <out.json>');
    process.exit(1);
  }
  const outFile = args[oIdx + 1];
  const inFiles = args.filter((a, i) => i !== oIdx && i !== oIdx + 1);
  const reports = inFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const merged = mergeReports(reports, inFiles.map((f) => path.basename(f)));
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`[ab-merge] ${inFiles.length} report(s), ${merged.n_pairs} pairs -> ${outFile}`);
  console.log('[ab-merge] summary:', JSON.stringify(merged.summary, null, 2));
}

if (require.main === module) main();

module.exports = { mergeReports };
