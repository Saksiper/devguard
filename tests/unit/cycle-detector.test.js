import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;

function loadModules() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/cycle-detector')];
  return {
    db: require('../../src/engine/db'),
    cd: require('../../src/engine/cycle-detector'),
  };
}

const DEFAULT_CONFIG = {
  similarity_threshold: 0.85,
  window_size: 10,
  min_occurrences: 2,
  block_threshold: 3,
  cooldown_actions: 5,
  max_entries: 10000,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-cycle-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/cycle-detector')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
  }
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    const { cd } = loadModules();
    expect(cd.jaccardSimilarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    const { cd } = loadModules();
    expect(cd.jaccardSimilarity('hello world', 'foo bar')).toBe(0.0);
  });

  it('returns value between 0 and 1 for partial overlap', () => {
    const { cd } = loadModules();
    const sim = cd.jaccardSimilarity('hello world foo', 'hello world bar');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    // intersection: {hello, world} = 2, union: {hello, world, foo, bar} = 4
    expect(sim).toBeCloseTo(0.5, 5);
  });

  it('returns 1.0 for both empty strings', () => {
    const { cd } = loadModules();
    expect(cd.jaccardSimilarity('', '')).toBe(1.0);
  });

  it('returns 0.0 when one string is empty', () => {
    const { cd } = loadModules();
    expect(cd.jaccardSimilarity('hello', '')).toBe(0.0);
    expect(cd.jaccardSimilarity('', 'hello')).toBe(0.0);
  });

  it('returns 0.0 for null/undefined inputs', () => {
    const { cd } = loadModules();
    expect(cd.jaccardSimilarity(null, 'hello')).toBe(0.0);
    expect(cd.jaccardSimilarity('hello', null)).toBe(0.0);
    expect(cd.jaccardSimilarity(null, null)).toBe(1.0);
  });

  it('is case insensitive', () => {
    const { cd } = loadModules();
    expect(cd.jaccardSimilarity('Hello World', 'hello world')).toBe(1.0);
  });

  it('handles duplicate tokens correctly (set-based)', () => {
    const { cd } = loadModules();
    // "a a a b" → Set{a, b}, "a b" → Set{a, b} → identical sets
    expect(cd.jaccardSimilarity('a a a b', 'a b')).toBe(1.0);
  });

  it('splits on code punctuation so identifiers overlap (not whitespace-only)', () => {
    const { cd } = loadModules();
    // Punctuation is stripped: "(elapsed" and "elapsed" become the same token.
    // Whitespace-only tokenizing scored these distinct → false non-match.
    const a = 'rate.refill(elapsed);';
    const b = 'rate.refill( elapsed );';
    // tokens both → {rate, refill, elapsed} → identical
    expect(cd.jaccardSimilarity(a, b)).toBe(1.0);
  });

  it('detects a realistic code oscillation above the 0.7 cycle threshold', () => {
    const { cd } = loadModules();
    // Same refill line reordered: whitespace-only tokenizing scored 0.64 (missed).
    // Punctuation-aware tokenizing scores 1.0 because identifiers overlap fully.
    const v1 = 'this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillRate);';
    const v2 = 'this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillRate) / 1000);';
    expect(cd.jaccardSimilarity(v1, v2)).toBeGreaterThan(0.7);
    expect(cd.jaccardSimilarity(v1, v2)).toBe(1.0);
  });
});

// NOTE: checkFileMatch removed in v0.2.2 — see [[file_match useless]] memory.
// "Same file edited N times" is empirically non-discriminative (10/10 manual samples FP).

describe('checkErrorHash', () => {
  it('returns skip on empty DB', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    const result = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('returns skip when error count below min_occurrences', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'hash-abc', session_id: 'sess-1' });
    const result = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('returns warn when error hash appears min_occurrences (2) times', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'hash-abc', session_id: 'sess-1' });
    proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'hash-abc', session_id: 'sess-1' });
    const result = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('warn');
    expect(result.level).toBe(1);
  });

  it('returns warn (not block) when error hash appears 3+ times', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    for (let i = 0; i < 3; i++) {
      proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'hash-abc', session_id: 'sess-1' });
    }
    const result = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('warn');
    expect(result.matches).toHaveLength(3);
  });

  it('checks the most recent error hash, not an arbitrary one', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    for (let i = 0; i < 3; i++) {
      proxy.insertErrorOutput({ error_string: 'old fail', error_hash: 'hash-old', session_id: 'sess-1' });
    }
    proxy.insertErrorOutput({ error_string: 'new fail', error_hash: 'hash-new', session_id: 'sess-1' });
    const result = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('ignores errors without hash', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertErrorOutput({ error_string: 'fail', error_hash: null, session_id: 'sess-1' });
    const result = cd.checkErrorHash(proxy, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('does not count errors from different session', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertSession('sess-2');
    for (let i = 0; i < 3; i++) {
      proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'hash-abc', session_id: 'sess-1' });
    }
    const result = cd.checkErrorHash(proxy, 'sess-2', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('returns skip for null sessionId', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    const result = cd.checkErrorHash(proxy, null, DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });
});

describe('checkDiffMatch', () => {
  it('returns skip on empty DB', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    const result = cd.checkDiffMatch(proxy, 'some code', 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('returns skip when no diff exceeds threshold', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertChange({ file: 'a.js', session_id: 'sess-1', diff_text: 'completely different code' });
    proxy.insertChange({ file: 'b.js', session_id: 'sess-1', diff_text: 'also very different stuff' });
    const result = cd.checkDiffMatch(proxy, 'const x = 1;', 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('returns warn when 2 diffs exceed threshold', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    const code = 'const value = getData();\nreturn value.map(x => x.id);';
    proxy.insertChange({ file: 'a.js', session_id: 'sess-1', diff_text: code });
    proxy.insertChange({ file: 'b.js', session_id: 'sess-1', diff_text: code });
    const result = cd.checkDiffMatch(proxy, code, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('warn');
    expect(result.level).toBe(2);
  });

  it('returns warn (not block) when 3+ diffs exceed threshold', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    const code = 'const value = getData();\nreturn value.map(x => x.id);';
    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: `f${i}.js`, session_id: 'sess-1', diff_text: code });
    }
    const result = cd.checkDiffMatch(proxy, code, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('warn');
    expect(result.matches).toHaveLength(3);
  });

  it('respects window_size limit', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    const code = 'const value = getData();';
    // Insert 5 matching changes
    for (let i = 0; i < 5; i++) {
      proxy.insertChange({ file: `f${i}.js`, session_id: 'sess-1', diff_text: code });
    }
    // With window_size=2, only last 2 should be checked
    const smallWindow = { ...DEFAULT_CONFIG, window_size: 2 };
    const result = cd.checkDiffMatch(proxy, code, 'sess-1', smallWindow);
    expect(result.decision).toBe('warn');
    expect(result.matches).toHaveLength(2);
  });

  it('returns skip for null oldString', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    const result = cd.checkDiffMatch(proxy, null, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('returns skip for null sessionId', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    const result = cd.checkDiffMatch(proxy, 'code', null, DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('skips changes with null diff_text', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertChange({ file: 'a.js', session_id: 'sess-1' }); // no diff_text
    proxy.insertChange({ file: 'b.js', session_id: 'sess-1' }); // no diff_text
    const result = cd.checkDiffMatch(proxy, 'const x = 1;', 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('does not count diffs from different session', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb('/test/project');
    proxy.insertSession('sess-1');
    proxy.insertSession('sess-2');
    const code = 'const value = getData();';
    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: `f${i}.js`, session_id: 'sess-1', diff_text: code });
    }
    const result = cd.checkDiffMatch(proxy, code, 'sess-2', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });
});

describe('cycle-detector — cross-project isolation', () => {
  it('checkErrorHash does not see errors from another project', () => {
    const { db, cd } = loadModules();
    const proxyA = db.getDb('/project-a');
    const proxyB = db.getDb('/project-b');
    proxyA.insertSession('sess-1');
    proxyB.insertSession('sess-1');
    for (let i = 0; i < 3; i++) {
      proxyA.insertErrorOutput({ error_string: 'fail', error_hash: 'hash-x', session_id: 'sess-1' });
    }
    const result = cd.checkErrorHash(proxyB, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });

  it('checkDiffMatch does not see diffs from another project', () => {
    const { db, cd } = loadModules();
    const proxyA = db.getDb('/project-a');
    const proxyB = db.getDb('/project-b');
    proxyA.insertSession('sess-1');
    proxyB.insertSession('sess-1');
    const code = 'const x = 1;';
    for (let i = 0; i < 3; i++) proxyA.insertChange({ file: 'a.js', session_id: 'sess-1', diff_text: code });
    const result = cd.checkDiffMatch(proxyB, code, 'sess-1', DEFAULT_CONFIG);
    expect(result.decision).toBe('skip');
  });
});

// Windows path / block_threshold / adaptive file_match tests removed with checkFileMatch v0.2.2.
// Adaptive threshold still tested below via error_hash subcategory.

describe('adaptive threshold pipeline integration', () => {
  it('error_hash uses adaptive threshold with hash prefix subcategory', () => {
    const { db, cd } = loadModules();
    const proxy = db.getDb(tmpDir);
    proxy.insertSession('sess-err');
    proxy.insertErrorOutput({ error_string: 'ECONNREFUSED', error_hash: 'abcd1234', session_id: 'sess-err' });
    proxy.insertErrorOutput({ error_string: 'ECONNREFUSED', error_hash: 'abcd1234', session_id: 'sess-err' });

    // High alpha for 'abcd' prefix → lowers threshold
    proxy.upsertThresholdParams('cycle:error_hash', 'abcd', 50.0, 2.0, 52);

    const config = { ...DEFAULT_CONFIG, min_occurrences: 3, adaptive_threshold: true };
    const result = cd.checkErrorHash(proxy, 'sess-err', config);
    expect(result.decision).toBe('warn');
    db.closeDb();
  });
});
