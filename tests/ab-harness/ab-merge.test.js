import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeReports } = require('../../tools/dg-ab-merge');

function pair(winner, control) {
  return {
    control,
    seeded: true,
    active: { isError: false, testPass: true, consistency: { score: 3, total: 3, checks: {} }, proxies: { changeCount: 1, cycleWarnCount: 0, sameFileEditsMax: 1, numTurns: 5, costUsd: 0.5, noteEvents: { surfaced: 1 } } },
    passive: { isError: false, testPass: true, consistency: { score: 0, total: 3, checks: {} }, proxies: { changeCount: 1, cycleWarnCount: 0, sameFileEditsMax: 1, numTurns: 5, costUsd: 0.5, noteEvents: {} } },
    verdict: { pair_winner: winner, consistent: true },
  };
}

const report = (pairs, model = 'opus') => ({ meta: { run_model: model, judge_model: model }, pairs });

describe('ab-merge: mergeReports', () => {
  it('concatenates pairs and recomputes the summary (controls partitioned)', () => {
    const merged = mergeReports(
      [report([pair('active'), pair('active')]), report([pair('active'), pair('tie', 'irrelevant')])],
      ['a.json', 'b.json']
    );
    expect(merged.n_pairs).toBe(4);
    expect(merged.summary.active_wins).toBe(3);
    expect(merged.summary.valid_pairs).toBe(3);
    expect(merged.summary.controls.irrelevant.ties).toBe(1);
    expect(merged.meta.merged_from).toEqual([
      { file: 'a.json', n_pairs: 2 },
      { file: 'b.json', n_pairs: 2 },
    ]);
  });

  it('throws loudly on a run/judge model mismatch', () => {
    expect(() => mergeReports([report([pair('active')]), report([pair('active')], 'sonnet')], ['a.json', 'b.json']))
      .toThrow(/model mismatch/);
  });

  it('refuses to merge fewer than 2 reports', () => {
    expect(() => mergeReports([report([pair('active')])], ['a.json'])).toThrow(/at least 2/);
  });
});
