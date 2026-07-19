import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeSummary, escapeLikePrefix } = require('../../tools/dg-ab-harness');

function pair(winner, { activeErr = false, passiveErr = false } = {}) {
  return {
    active: { isError: activeErr, testPass: true, proxies: { changeCount: 1, cycleWarnCount: 0, sameFileEditsMax: 1, numTurns: 3 } },
    passive: { isError: passiveErr, testPass: true, proxies: { changeCount: 1, cycleWarnCount: 0, sameFileEditsMax: 1, numTurns: 3 } },
    verdict: { pair_winner: winner, consistent: true },
  };
}

describe('ab-harness: computeSummary excludes errored arms (MAJOR-2)', () => {
  it('does not count a pair where either arm errored', () => {
    const s = computeSummary([
      pair('active'),
      pair('passive', { activeErr: true }), // errored -> excluded
      pair('active'),
    ]);
    expect(s.active_wins).toBe(2);
    expect(s.passive_wins).toBe(0);
    expect(s.errored_pairs).toBe(1);
    expect(s.active_win_rate).toBe(1); // 2/2 valid decisive, errored pair not in denominator
  });

  it('reports null win-rate when no decisive valid pairs', () => {
    const s = computeSummary([pair('tie'), pair('active', { passiveErr: true })]);
    expect(s.active_win_rate).toBe(null);
    expect(s.errored_pairs).toBe(1);
  });
});

describe('ab-harness: escapeLikePrefix (MAJOR-6)', () => {
  it('escapes LIKE wildcards % _ and backslash', () => {
    expect(escapeLikePrefix('C:/Users/umut_/tmp')).toBe('C:/Users/umut\\_/tmp');
    expect(escapeLikePrefix('a%b')).toBe('a\\%b');
    expect(escapeLikePrefix('a\\b')).toBe('a\\\\b');
  });
});
