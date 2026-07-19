import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildContextSummary,
  buildTimeline,
  findDominantFile,
  findDominantError,
} = require('../../src/engine/context-summarizer');

function makeDb(overrides = {}) {
  return {
    getChanges: () => [],
    getErrorOutputs: () => [],
    ...overrides,
  };
}

const defaultConfig = {
  context_summary_confidence_threshold: 0.6,
  context_summary_enabled: true,
};

describe('buildTimeline', () => {
  it('returns null for empty changes', () => {
    expect(buildTimeline([], [])).toBeNull();
  });

  it('builds timeline with changes and errors', () => {
    const changes = [
      { id: 2, file: 'app.js', description: 'add retry', timestamp: '2026-04-04T14:25:00Z' },
      { id: 1, file: 'app.js', description: 'first attempt', timestamp: '2026-04-04T14:22:00Z' },
    ];
    const errors = [
      { id: 1, change_id: 1, error_string: 'ECONNREFUSED', error_hash: 'abc' },
    ];

    const timeline = buildTimeline(changes, errors);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].description).toBe('first attempt');
    expect(timeline[0].error).toBe('ECONNREFUSED');
    expect(timeline[1].description).toBe('add retry');
    expect(timeline[1].error).toBeNull();
  });

  it('limits to 5 entries', () => {
    const changes = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, file: 'f.js', description: `change ${i}`,
    }));
    const timeline = buildTimeline(changes, []);
    expect(timeline.length).toBeLessThanOrEqual(5);
  });
});

describe('findDominantFile', () => {
  it('returns null for empty changes', () => {
    expect(findDominantFile([])).toBeNull();
  });

  it('returns dominant file when >= 50%', () => {
    const changes = [
      { file: 'app.js' }, { file: 'app.js' }, { file: 'app.js' },
      { file: 'utils.js' },
    ];
    const result = findDominantFile(changes);
    expect(result).not.toBeNull();
    expect(result.file).toBe('app.js');
    expect(result.count).toBe(3);
    expect(result.total).toBe(4);
  });

  it('returns null when no dominant file', () => {
    const changes = [
      { file: 'a.js' }, { file: 'b.js' }, { file: 'c.js' }, { file: 'd.js' },
    ];
    expect(findDominantFile(changes)).toBeNull();
  });
});

describe('findDominantError', () => {
  it('returns null for no errors', () => {
    expect(findDominantError([])).toBeNull();
  });

  it('returns most frequent error hash', () => {
    const errors = [
      { error_hash: 'abc', error_string: 'ECONNREFUSED' },
      { error_hash: 'abc', error_string: 'ECONNREFUSED' },
      { error_hash: 'def', error_string: 'TypeError' },
    ];
    const result = findDominantError(errors);
    expect(result).not.toBeNull();
    expect(result.hash).toBe('abc');
    expect(result.count).toBe(2);
    expect(result.preview).toContain('ECONNREFUSED');
  });
});

describe('buildContextSummary', () => {
  it('returns null for empty results', () => {
    const db = makeDb();
    expect(buildContextSummary(db, 'sess1', [], defaultConfig)).toBeNull();
  });

  it('returns null for protection-only results', () => {
    const db = makeDb();
    const results = [{ type: 'protection', confidence: 1.0 }];
    expect(buildContextSummary(db, 'sess1', results, defaultConfig)).toBeNull();
  });

  it('returns null when avg confidence below threshold', () => {
    const db = makeDb({ getChanges: () => [{ file: 'a.js' }], getErrorOutputs: () => [] });
    const results = [{ type: 'file_match', confidence: 0.3 }];
    expect(buildContextSummary(db, 'sess1', results, defaultConfig)).toBeNull();
  });

  it('builds full summary with timeline and observations', () => {
    const db = makeDb({
      getChanges: () => [
        { id: 2, file: 'app.js', description: 'retry with delay', timestamp: '2026-04-04T14:25:00Z' },
        { id: 1, file: 'app.js', description: 'first connect attempt', timestamp: '2026-04-04T14:22:00Z' },
      ],
      getErrorOutputs: () => [
        { id: 1, change_id: 1, error_string: 'ECONNREFUSED', error_hash: 'abc' },
        { id: 2, change_id: 2, error_string: 'ECONNREFUSED', error_hash: 'abc' },
      ],
    });

    const results = [
      { type: 'file_match', confidence: 0.8 },
      { type: 'error_hash', confidence: 0.9 },
    ];

    const summary = buildContextSummary(db, 'sess1', results, defaultConfig);
    expect(summary).not.toBeNull();
    expect(summary).toContain('Session summary:');
    expect(summary).toContain('2 changes');
    expect(summary).toContain('2 errors');
    expect(summary).toContain('Approach history');
    expect(summary).toContain('first connect attempt');
    expect(summary).toContain('ECONNREFUSED');
    expect(summary).toContain('Observation');
  });

  it('skips summary when config disables it', () => {
    const db = makeDb({
      getChanges: () => [{ id: 1, file: 'a.js' }],
      getErrorOutputs: () => [],
    });
    const results = [{ type: 'file_match', confidence: 0.8 }];
    const config = { ...defaultConfig, context_summary_confidence_threshold: 0.99 };
    expect(buildContextSummary(db, 'sess1', results, config)).toBeNull();
  });
});
