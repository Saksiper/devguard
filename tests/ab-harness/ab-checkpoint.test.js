import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCheckpoint, planResume, bothArmsErrored } = require('../../tools/dg-ab-harness');

const arm = (isError) => ({ isError, testPass: true, consistency: null, proxies: {} });
const pair = (task, replica, { activeErr = false, passiveErr = false } = {}) => ({
  task, replica, active: arm(activeErr), passive: arm(passiveErr), verdict: { pair_winner: 'tie', consistent: true },
});

describe('ab-harness: loadCheckpoint', () => {
  it('returns [] when the report file does not exist (first run of a resumable batch)', () => {
    expect(loadCheckpoint(path.join(os.tmpdir(), 'dg-ab-no-such-report.json'))).toEqual([]);
  });

  it('returns the pairs array from an existing report', () => {
    const f = path.join(os.tmpdir(), `dg-ab-cp-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify({ meta: {}, pairs: [pair('t1', 1)] }), 'utf8');
    try {
      expect(loadCheckpoint(f)).toHaveLength(1);
    } finally { fs.rmSync(f); }
  });

  it('throws loudly on a corrupt or pair-less report instead of silently starting fresh', () => {
    const f = path.join(os.tmpdir(), `dg-ab-cp-bad-${process.pid}.json`);
    fs.writeFileSync(f, '{not json', 'utf8');
    try {
      expect(() => loadCheckpoint(f)).toThrow();
      fs.writeFileSync(f, JSON.stringify({ meta: {} }), 'utf8');
      expect(() => loadCheckpoint(f)).toThrow(/pairs/);
    } finally { fs.rmSync(f); }
  });
});

describe('ab-harness: planResume', () => {
  const runList = [
    { taskId: 't1', replica: 1 },
    { taskId: 't2', replica: 1 },
    { taskId: 't2', replica: 2 },
  ];

  it('keeps valid checkpoint pairs and only re-runs missing or errored ones', () => {
    const cp = [
      pair('t1', 1), // valid -> keep, skip
      pair('t2', 1, { activeErr: true }), // errored + in run list -> re-run, drop from keep
      // t2#2 missing -> run
    ];
    const plan = planResume(runList, cp);
    expect(plan.keepPairs.map((p) => `${p.task}#${p.replica}`)).toEqual(['t1#1']);
    expect(plan.toRun).toEqual([
      { taskId: 't2', replica: 1 },
      { taskId: 't2', replica: 2 },
    ]);
  });

  it('preserves checkpoint pairs (valid AND errored) whose task is not in the current run list', () => {
    const cp = [pair('other', 1), pair('other-err', 1, { passiveErr: true })];
    const plan = planResume(runList, cp);
    expect(plan.keepPairs).toHaveLength(2); // untouched batches survive the merge untouched
    expect(plan.toRun).toHaveLength(3);
  });

  it('fresh start: empty checkpoint runs everything', () => {
    const plan = planResume(runList, []);
    expect(plan.keepPairs).toEqual([]);
    expect(plan.toRun).toHaveLength(3);
  });
});

describe('ab-harness: bothArmsErrored (usage-limit signature)', () => {
  it('is true only when BOTH arms errored', () => {
    expect(bothArmsErrored(pair('t', 1, { activeErr: true, passiveErr: true }))).toBe(true);
    expect(bothArmsErrored(pair('t', 1, { activeErr: true }))).toBe(false);
    expect(bothArmsErrored(pair('t', 1))).toBe(false);
  });
});
