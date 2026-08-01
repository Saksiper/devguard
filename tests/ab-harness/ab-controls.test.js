import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { computeSummary } = require('../../tools/dg-ab-harness');
const { taskNeedsEmbeddingResolver } = require('../../tools/dg-ab-runner');
const { isValidNodeId } = require('../../src/engine/node-taxonomy');

const CONTROL_TYPES = ['irrelevant', 'misleading', 'none'];

function pair(winner, { control, seeded = true, activeErr = false, passiveErr = false, consistency = null } = {}) {
  const arm = (isError, score) => ({
    isError,
    testPass: true,
    consistency: score === null ? null : { score, total: 3, checks: {} },
    proxies: { changeCount: 1, cycleWarnCount: 0, sameFileEditsMax: 1, numTurns: 5, costUsd: 0.5, noteEvents: seeded ? { surfaced: 1 } : {} },
  });
  return {
    control,
    seeded,
    active: arm(activeErr, consistency ? consistency.active : null),
    passive: arm(passiveErr, consistency ? consistency.passive : null),
    verdict: { pair_winner: winner, consistent: true },
  };
}

describe('ab-harness: computeSummary partitions control pairs out of headline metrics', () => {
  it('excludes control pairs from wins, win rate, and valid_pairs', () => {
    const s = computeSummary([
      pair('active'),
      pair('active'),
      pair('active', { control: 'irrelevant' }), // must NOT inflate the headline
      pair('passive', { control: 'misleading' }), // must NOT deflate it either
    ]);
    expect(s.active_wins).toBe(2);
    expect(s.passive_wins).toBe(0);
    expect(s.active_win_rate).toBe(1);
    expect(s.valid_pairs).toBe(2);
    expect(s.control_pairs).toBe(2);
  });

  it('groups control pairs by type with descriptive counts and per-arm means (no win rate, no CI)', () => {
    const s = computeSummary([
      pair('active'),
      pair('tie', { control: 'irrelevant' }),
      pair('passive', { control: 'irrelevant' }),
      pair('active', { control: 'misleading', consistency: { active: 3, passive: 0 } }),
      pair('tie', { control: 'none', seeded: false }),
    ]);
    expect(s.controls.irrelevant).toMatchObject({ pairs: 2, errored: 0, active_wins: 0, passive_wins: 1, ties: 1 });
    expect(s.controls.misleading).toMatchObject({ pairs: 1, active_wins: 1 });
    // misleading consistency = resistance to the stale note (current-spec adherence)
    expect(s.controls.misleading.consistency).toEqual({ active: 3, passive: 0 });
    expect(s.controls.none).toMatchObject({ pairs: 1, ties: 1 });
    // none-type pairs are unseeded -> surfaced means stay null, not 0
    expect(s.controls.none.surfaced).toEqual({ active: null, passive: null });
    expect(s.controls.irrelevant.numTurns).toEqual({ active: 5, passive: 5 });
    expect(s.controls.irrelevant.costUsd).toEqual({ active: 0.5, passive: 0.5 });
    expect(s.controls.irrelevant).not.toHaveProperty('active_win_rate');
    expect(s.controls.irrelevant).not.toHaveProperty('active_win_rate_ci_wilson');
  });

  it('counts an errored control pair under its type, not in the experimental pool', () => {
    const s = computeSummary([
      pair('active'),
      pair('active', { control: 'irrelevant', activeErr: true }),
    ]);
    expect(s.errored_pairs).toBe(1);
    expect(s.controls.irrelevant).toMatchObject({ pairs: 0, errored: 1 });
    expect(s.valid_pairs).toBe(1);
    expect(s.active_wins).toBe(1);
  });

  it('keeps the summary shape byte-identical to today when no control pairs exist', () => {
    const s = computeSummary([pair('active'), pair('tie')]);
    expect(s).not.toHaveProperty('controls');
    expect(s).not.toHaveProperty('control_pairs');
  });
});

describe('tasks.json: control task bank guard', () => {
  const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
  const controls = bank.tasks.filter((t) => t.control);
  const byType = (type) => controls.filter((t) => t.control === type);

  it('ships 3 irrelevant + 3 misleading + 2 none control tasks', () => {
    expect(byType('irrelevant').length).toBe(3);
    expect(byType('misleading').length).toBe(3);
    expect(byType('none').length).toBe(2);
  });

  it('every control task has a valid type, ctrl- id prefix, and a decision-free rubric', () => {
    for (const t of controls) {
      expect(CONTROL_TYPES, `${t.id}: unknown control type ${t.control}`).toContain(t.control);
      expect(t.id.startsWith('ctrl-'), `${t.id}: control ids must start with ctrl-`).toBe(true);
      // The rubric must never endorse the seeded note as established context —
      // that endorsement is exactly what makes positive-task wins tautological.
      expect(t.judge.rubric, `${t.id}: rubric endorses the seeded note`).not.toMatch(/established (project )?decisions|project context|consistency with these/i);
    }
  });

  it('irrelevant tasks seed an off-topic note that can only surface via an aligned centroid', () => {
    for (const t of byType('irrelevant')) {
      expect(t.mode, `${t.id}: irrelevant tasks use mode "control"`).toBe('control');
      expect(t.seedNotes && t.seedNotes.length, `${t.id}: needs seedNotes`).toBeTruthy();
      for (const s of t.seedNotes) {
        // Off-topic note text never keyword-resolves the prompt, so the embedding
        // resolver (fed by seedFeatureText) is the only surface path.
        expect(s.seedFeatureText, `${t.id}: irrelevant seed needs topic-aligned seedFeatureText`).toBeTruthy();
        expect(isValidNodeId(s.nodeId), `${t.id}: invalid node_id ${s.nodeId}`).toBe(true);
        expect(s.text).not.toMatch(/devguard|dg-note/i);
      }
      expect(taskNeedsEmbeddingResolver(t), `${t.id}: note is keyword-reachable — not off-topic enough`).toBe(true);
    }
  });

  it('none tasks seed nothing', () => {
    for (const t of byType('none')) {
      expect(t.mode).toBe('control');
      expect(t.seedNotes || []).toEqual([]);
    }
  });

  it('misleading tasks are mode:sphere so the existing bank-alignment and refs-differential guards bite', () => {
    for (const t of byType('misleading')) {
      expect(t.mode, `${t.id}: misleading tasks must be mode "sphere"`).toBe('sphere');
      // The prompt must state the supersession explicitly — v1 measures the
      // easy-resistance case (contradiction visible in the prompt).
      expect(t.prompt, `${t.id}: prompt must state the requirement change`).toMatch(/changed|superseded|no longer|instead of the old/i);
    }
  });

  it('a control task reusing a fixture MUST declare its hidden graders (leak guard)', () => {
    // setupSandbox removes only the files THIS task declares; an undeclared
    // consistency.js would stay visible to Claude in the sandbox.
    for (const t of controls) {
      const fx = path.join(__dirname, t.fixtureDir);
      for (const hidden of ['test.js', 'consistency.js']) {
        if (!fs.existsSync(path.join(fx, hidden))) continue;
        const declared = [t.test && t.test.file, t.consistencyTest && t.consistencyTest.file];
        expect(declared, `${t.id}: ${hidden} exists in ${t.fixtureDir} but is not declared — it would leak into the sandbox`).toContain(hidden);
      }
    }
  });
});
