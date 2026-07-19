import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { tokens, buildIndex, resolveIndex, resolveByProjectIndex, resolveBootstrapFeature } = require('../../src/engine/keyword-index');

describe('keyword-index — tokens', () => {
  it('lowercases, drops <3-char and stopwords', () => {
    expect(tokens('The highlight WRAPS a range')).toEqual(['highlight', 'wraps', 'range']);
  });
  it('handles null/empty', () => {
    expect(tokens(null)).toEqual([]);
    expect(tokens('')).toEqual([]);
  });
});

describe('keyword-index — buildIndex', () => {
  it('builds per-node token sets and document frequency', () => {
    const idx = buildIndex([
      { node_id: 'n/a', text: 'alpha bravo charlie' },
      { node_id: 'n/b', text: 'alpha delta echo' },
    ]);
    expect(idx.nodes.get('n/a').has('bravo')).toBe(true);
    expect(idx.df.alpha).toBe(2); // shared by both nodes
    expect(idx.df.bravo).toBe(1);
  });
  it('merges multiple notes on the same node', () => {
    const idx = buildIndex([
      { node_id: 'n/a', text: 'alpha' },
      { node_id: 'n/a', text: 'bravo' },
    ]);
    expect(idx.nodes.size).toBe(1);
    expect(idx.nodes.get('n/a').has('alpha')).toBe(true);
    expect(idx.nodes.get('n/a').has('bravo')).toBe(true);
  });
  it('skips docs without a node_id', () => {
    const idx = buildIndex([{ text: 'orphan' }, { node_id: 'n/a', text: 'alpha' }]);
    expect(idx.nodes.size).toBe(1);
  });
});

describe('keyword-index — resolveIndex confidence gate (margin 0.75)', () => {
  const idx = buildIndex([
    { node_id: 'n/a', text: 'alpha bravo charlie' },
    { node_id: 'n/b', text: 'alpha delta echo' },
  ]);

  it('CONFIDENT: a distinctive prompt resolves (margin well below threshold)', () => {
    // 'bravo' is unique to n/a; margin = second/top = 0.5/1.5 = 0.33 < 0.75
    expect(resolveIndex(idx, 'alpha bravo', 0.75)).toBe('n/a');
  });

  it('AMBIGUOUS: a shared-only prompt defers (both tie, margin 1.0 >= 0.75)', () => {
    // only 'alpha' overlaps; both nodes score 0.5 -> margin 1.0 -> null
    expect(resolveIndex(idx, 'alpha', 0.75)).toBeNull();
  });

  it('threshold is honoured: a mid-margin case flips with the knob', () => {
    // Construct margin ~0.5: top has a unique+shared, runner-up has the shared.
    const m = buildIndex([
      { node_id: 'p/x', text: 'zeta unique1 unique2' },
      { node_id: 'p/y', text: 'zeta' },
    ]);
    // prompt 'zeta unique1' -> x: zeta(0.5)+unique1(1)=1.5, y: zeta(0.5) -> margin 0.33
    expect(resolveIndex(m, 'zeta unique1', 0.75)).toBe('p/x'); // confident
    expect(resolveIndex(m, 'zeta unique1', 0.30)).toBeNull();  // stricter knob -> defer
  });
});

describe('keyword-index — resolveIndex floor and empties', () => {
  it('WEAK: returns null when the top score is below the floor', () => {
    // 4 nodes all share 'data' -> df=4 -> a 'data'-only prompt scores 0.25 < 0.3 floor
    const idx = buildIndex([
      { node_id: 'a/1', text: 'data' }, { node_id: 'a/2', text: 'data' },
      { node_id: 'a/3', text: 'data' }, { node_id: 'a/4', text: 'data' },
    ]);
    expect(resolveIndex(idx, 'data', 0.75, 0.3)).toBeNull();
  });
  it('returns null for an unrelated prompt (no overlap)', () => {
    const idx = buildIndex([{ node_id: 'n/a', text: 'alpha bravo' }]);
    expect(resolveIndex(idx, 'nothing matches here', 0.75)).toBeNull();
  });
  it('returns null for empty prompt or empty index', () => {
    expect(resolveIndex(buildIndex([{ node_id: 'n/a', text: 'alpha' }]), '', 0.75)).toBeNull();
    expect(resolveIndex(buildIndex([]), 'alpha', 0.75)).toBeNull();
  });
});

// --- 2026-07-18 noise fix: live false-surfaces in the devguard project itself ---
// Mechanically reproduced (real DB + real prompts): 3 unrelated Turkish prompts
// surfaced ui_ux/filter because (a) Turkish function words counted as content,
// (b) in a small index (df=1) ONE stray prose token cleared the 0.3 floor, and
// (c) dead superseded layers kept feeding the node's vocabulary.

describe('keyword-index — Turkish function words are stopwords', () => {
  it('drops Turkish function words like their English counterparts', () => {
    expect(tokens('yeni bir şey için onu değil')).toEqual([]);
  });
  it('keeps Turkish content words', () => {
    expect(tokens('filtre büyük-küçük harf duyarsız')).toEqual(['filtre', 'büyük', 'küçük', 'harf', 'duyarsız']);
  });
  it('LIVE REPRO: unrelated Turkish prompt no longer matches bookkeeping prose', () => {
    const idx = buildIndex([
      { node_id: 'ui_ux/filter', text: 'doğrulama yeni oturuma devrediliyordu çünkü restart bekleniyordu' },
    ]);
    // live case matched solely via the function word 'yeni'
    expect(resolveIndex(idx, 'Açık kalan tek yeni işi çöz', 0.75)).toBeNull();
  });
});

describe('keyword-index — a single stray prose token is not evidence', () => {
  const idx = buildIndex([
    { node_id: 'ui_ux/filter', text: 'status defter kaydı gürültü ticket bulgusu' },
  ]);
  it('one prose-only hit defers (df=1 lets any word clear the floor)', () => {
    expect(resolveIndex(idx, 'update the status page', 0.75)).toBeNull();
  });
  it('two distinct content hits still resolve', () => {
    expect(resolveIndex(idx, 'status ticket incelemesi', 0.75)).toBe('ui_ux/filter');
  });
  it('a single hit that NAMES the feature still resolves (pinned product path)', () => {
    const one = buildIndex([{ node_id: 'ui_ux/filter', text: 'made the match case-insensitive' }]);
    expect(resolveIndex(one, 'tweak the filter behavior', 0.75)).toBe('ui_ux/filter');
  });
});

describe('keyword-index — superseded layers do not feed the index (head-only)', () => {
  const chainDb = () => ({ getNotes: () => [
    { node_id: 'ui_ux/filter', note_text: 'bump 3f2c9dd devguard master pipeline reinstall', superseded_by: 99 },
    { node_id: 'ui_ux/filter', note_text: 'made the title match case-insensitive', superseded_by: null },
  ] });
  it('LIVE REPRO: dead bookkeeping vocabulary cannot draw a surface', () => {
    // live case (CI failure mail) matched via commit-hash/repo tokens from DEAD layers
    expect(resolveByProjectIndex(chainDb(), 'githubu kontrol et: devguard master 3f2c9dd failed', 0.75)).toBeNull();
  });
  it('the head layer still resolves', () => {
    expect(resolveByProjectIndex(chainDb(), 'match the title case-insensitive please', 0.75)).toBe('ui_ux/filter');
  });
});

describe('keyword-index — resolveByProjectIndex (db-backed)', () => {
  const fakeDb = (notes) => ({ getNotes: () => notes });

  it('resolves confidently against the project notes', () => {
    const db = fakeDb([
      { node_id: 'ui/highlight', note_text: 'highlight wraps character offset ranges with markers' },
      { node_id: 'logic/score', note_text: 'exam net score negative marking penalty' },
    ]);
    expect(resolveByProjectIndex(db, 'highlight the character ranges with markers', 0.75)).toBe('ui/highlight');
  });

  it('defers (null) when two vocab-neighbour nodes tie', () => {
    const db = fakeDb([
      { node_id: 'logic/classify', note_text: 'classify into topic category taxonomy' },
      { node_id: 'logic/lookup', note_text: 'look up topic by section record' },
    ]);
    // prompt shares only 'topic' with both -> ambiguous -> null (embedding fallback)
    expect(resolveByProjectIndex(db, 'the topic assigned to this item', 0.75)).toBeNull();
  });

  it('returns null when the project has no notes', () => {
    expect(resolveByProjectIndex(fakeDb([]), 'anything', 0.75)).toBeNull();
  });
});

describe('keyword-index — resolveBootstrapFeature (learned per-project vocabulary)', () => {
  const fakeDb = (features) => ({ getAllFeatures: () => features });

  it('names a feature the project itself created when the prompt contains its name', () => {
    const db = fakeDb([{ node_id: 'ui_ux/export', continent: 'ui_ux', country: 'export' }]);
    expect(resolveBootstrapFeature(db, 'fix the export button')).toBe('ui_ux/export');
  });

  it('requires ALL name tokens for multi-word countries', () => {
    const db = fakeDb([{ node_id: 'data/data-import', continent: 'data', country: 'data-import' }]);
    expect(resolveBootstrapFeature(db, 'import the data from csv')).toBe('data/data-import');
    expect(resolveBootstrapFeature(db, 'just import it')).toBeNull();
  });

  it('never fires from stopwords, short tokens, or an empty features table', () => {
    expect(resolveBootstrapFeature(fakeDb([]), 'add a filter')).toBeNull();
    const db = fakeDb([{ node_id: 'misc/the', continent: 'misc', country: 'the' }]);
    expect(resolveBootstrapFeature(db, 'the thing over there')).toBeNull();
  });

  it('prefers the most specific (longest-name) feature on overlap', () => {
    const db = fakeDb([
      { node_id: 'ui_ux/export', continent: 'ui_ux', country: 'export' },
      { node_id: 'ui_ux/export-csv', continent: 'ui_ux', country: 'export-csv' },
    ]);
    expect(resolveBootstrapFeature(db, 'the csv export flow')).toBe('ui_ux/export-csv');
  });

  it('returns null (never throws) when db lacks getAllFeatures', () => {
    expect(resolveBootstrapFeature({}, 'export the data')).toBeNull();
  });
});
