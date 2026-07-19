import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildJudgePrompt, parseJudgeVerdict, aggregateSwappedVerdicts } = require('../../tools/dg-ab-judge');

describe('ab-judge: buildJudgePrompt (neutral, no leak)', () => {
  const task = { name: 'Rate limiter', prompt: 'Fix the token bucket', judge: { rubric: 'unit-correctness and edge cases' } };

  it('embeds both solutions and the rubric', () => {
    const p = buildJudgePrompt(task, 'SOLUTION_ALPHA_CODE', 'SOLUTION_BETA_CODE');
    expect(p).toContain('SOLUTION_ALPHA_CODE');
    expect(p).toContain('SOLUTION_BETA_CODE');
    expect(p).toContain('unit-correctness and edge cases');
  });

  it('never mentions DevGuard or DG markers (blind judge)', () => {
    const p = buildJudgePrompt(task, 'a', 'b');
    expect(p).not.toMatch(/DevGuard/i);
    expect(p).not.toMatch(/DG-NOTE/);
    expect(p).not.toMatch(/intervention/i);
  });

  it('asks for a strict JSON verdict with winner A/B/tie', () => {
    const p = buildJudgePrompt(task, 'a', 'b');
    expect(p).toMatch(/winner/i);
    expect(p).toMatch(/JSON/i);
  });
});

describe('ab-judge: parseJudgeVerdict (defensive)', () => {
  it('parses a plain JSON verdict', () => {
    const v = parseJudgeVerdict('{"winner":"A","reason":"clearer","confidence":0.8}');
    expect(v.winner).toBe('A');
    expect(v.reason).toBe('clearer');
  });

  it('unwraps a claude -p --output-format json envelope (.result holds the verdict)', () => {
    const envelope = JSON.stringify({ type: 'result', is_error: false, result: '{"winner":"B","reason":"safer"}' });
    const v = parseJudgeVerdict(envelope);
    expect(v.winner).toBe('B');
  });

  it('extracts JSON from a ```json fenced block', () => {
    const v = parseJudgeVerdict('Here is my verdict:\n```json\n{"winner":"tie","reason":"equal"}\n```\n');
    expect(v.winner).toBe('tie');
  });

  it('extracts the first balanced {...} object embedded in prose', () => {
    const v = parseJudgeVerdict('I think {"winner":"A","reason":"x"} is better.');
    expect(v.winner).toBe('A');
  });

  it('falls back to a regex when JSON is malformed', () => {
    const v = parseJudgeVerdict('{"winner": "B", "reason": unterminated');
    expect(v.winner).toBe('B');
  });

  it('returns tie for an invalid winner value', () => {
    expect(parseJudgeVerdict('{"winner":"C"}').winner).toBe('tie');
  });

  // MAJOR-4: LLMs often emit lowercase; must not silently collapse to tie.
  it('normalizes lowercase winner a/b to A/B', () => {
    expect(parseJudgeVerdict('{"winner":"a"}').winner).toBe('A');
    expect(parseJudgeVerdict('{"winner":"b","reason":"x"}').winner).toBe('B');
    expect(parseJudgeVerdict('{"winner":"TIE"}').winner).toBe('tie');
  });

  it('returns tie for total garbage', () => {
    const v = parseJudgeVerdict('no json here at all');
    expect(v.winner).toBe('tie');
  });
});

describe('ab-judge: aggregateSwappedVerdicts (position-swap)', () => {
  // Round 1: pos A = passive, pos B = active. Round 2 swaps positions.
  const R1 = { armAtA: 'passive', armAtB: 'active' };
  const R2 = { armAtA: 'active', armAtB: 'passive' };

  it('same arm wins in both rounds -> that arm, consistent', () => {
    // active wins both: R1 winner B (=active), R2 winner A (=active)
    const agg = aggregateSwappedVerdicts({ ...R1, winner: 'B' }, { ...R2, winner: 'A' });
    expect(agg.pair_winner).toBe('active');
    expect(agg.consistent).toBe(true);
  });

  it('judge picks the SAME position both rounds -> position bias -> tie, inconsistent', () => {
    // winner A both rounds: R1 A=passive, R2 A=active -> conflict
    const agg = aggregateSwappedVerdicts({ ...R1, winner: 'A' }, { ...R2, winner: 'A' });
    expect(agg.pair_winner).toBe('tie');
    expect(agg.consistent).toBe(false);
  });

  // MAJOR-3: a single decisive round is NOT swap-confirmed -> tie, not decisive.
  it('one net signal + one tie -> tie (unconfirmed), not decisive', () => {
    const agg = aggregateSwappedVerdicts({ ...R1, winner: 'B' }, { ...R2, winner: 'tie' });
    expect(agg.pair_winner).toBe('tie');
    expect(agg.consistent).toBe(false);
  });

  it('both tie -> tie, consistent', () => {
    const agg = aggregateSwappedVerdicts({ ...R1, winner: 'tie' }, { ...R2, winner: 'tie' });
    expect(agg.pair_winner).toBe('tie');
    expect(agg.consistent).toBe(true);
  });
});
