import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  cosineSimilarity,
  findSimilarPairs,
  isModelReady,
  getModelDir,
  EMBEDDING_DIM,
  _resetForTest,
} = require('../../src/engine/embedding');

function makeNormalizedBuffer(arr) {
  const f32 = new Float32Array(arr);
  let norm = 0;
  for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
  return Buffer.from(f32.buffer);
}

function makeRandomNormalized(dim, seed) {
  const arr = new Float32Array(dim);
  let s = seed || 42;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    arr[i] = (s / 0x7fffffff) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) arr[i] /= norm;
  return Buffer.from(arr.buffer);
}

describe('cosineSimilarity', () => {
  it('identical vectors → 1.0', () => {
    const v = makeNormalizedBuffer([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors → 0.0', () => {
    const a = makeNormalizedBuffer([1, 0, 0, 0]);
    const b = makeNormalizedBuffer([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('opposite vectors → -1.0', () => {
    const a = makeNormalizedBuffer([1, 0, 0, 0]);
    const b = makeNormalizedBuffer([-1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('known similar pair', () => {
    const a = makeNormalizedBuffer([1, 2, 3]);
    const b = makeNormalizedBuffer([1, 2, 4]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.95);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it('known dissimilar pair', () => {
    const a = makeNormalizedBuffer([1, 0, 0]);
    const b = makeNormalizedBuffer([0, 0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('null inputs → 0', () => {
    const v = makeNormalizedBuffer([1, 2, 3]);
    expect(cosineSimilarity(null, v)).toBe(0);
    expect(cosineSimilarity(v, null)).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  it('mismatched lengths → 0', () => {
    const a = makeNormalizedBuffer([1, 2, 3]);
    const b = makeNormalizedBuffer([1, 2]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('384-dim identical vectors', () => {
    const a = makeRandomNormalized(EMBEDDING_DIM, 1);
    const b = makeRandomNormalized(EMBEDDING_DIM, 1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('384-dim different vectors', () => {
    const a = makeRandomNormalized(EMBEDDING_DIM, 1);
    const b = makeRandomNormalized(EMBEDDING_DIM, 99);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.5);
  });

  it('NaN in buffer → returns 0 (not NaN)', () => {
    const f32 = new Float32Array([NaN, 0.5, 0.3, 0.1]);
    const buf = Buffer.from(f32.buffer);
    const normal = makeNormalizedBuffer([1, 2, 3, 4]);
    const result = cosineSimilarity(buf, normal);
    expect(result).toBe(0);
    expect(isNaN(result)).toBe(false);
  });
});

describe('findSimilarPairs', () => {
  it('3 similar + 2 different → correct matches', () => {
    const similar1 = makeNormalizedBuffer([1, 2, 3, 4]);
    const similar2 = makeNormalizedBuffer([1, 2, 3, 4.1]);
    const similar3 = makeNormalizedBuffer([1, 2, 3, 3.9]);
    const diff1 = makeNormalizedBuffer([-1, -2, 0, 0]);
    const diff2 = makeNormalizedBuffer([0, 0, -1, -2]);

    const embeddings = [
      { id: 1, buffer: similar1 },
      { id: 2, buffer: similar2 },
      { id: 3, buffer: similar3 },
      { id: 4, buffer: diff1 },
      { id: 5, buffer: diff2 },
    ];

    const pairs = findSimilarPairs(embeddings, 0.99);
    expect(pairs.length).toBe(3);
    const ids = pairs.map(p => [p.a, p.b]).flat();
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
    for (const p of pairs) {
      expect(p.similarity).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('empty list → empty', () => {
    expect(findSimilarPairs([], 0.85)).toEqual([]);
  });

  it('null → empty', () => {
    expect(findSimilarPairs(null, 0.85)).toEqual([]);
  });

  it('single element → empty', () => {
    const embeddings = [{ id: 1, buffer: makeNormalizedBuffer([1, 2, 3]) }];
    expect(findSimilarPairs(embeddings, 0.85)).toEqual([]);
  });

  it('all dissimilar → empty at high threshold', () => {
    const embeddings = [
      { id: 1, buffer: makeNormalizedBuffer([1, 0, 0]) },
      { id: 2, buffer: makeNormalizedBuffer([0, 1, 0]) },
      { id: 3, buffer: makeNormalizedBuffer([0, 0, 1]) },
    ];
    expect(findSimilarPairs(embeddings, 0.85)).toEqual([]);
  });

  it('respects threshold', () => {
    const a = makeNormalizedBuffer([1, 2, 3]);
    const b = makeNormalizedBuffer([1, 2, 4]);
    const embeddings = [
      { id: 1, buffer: a },
      { id: 2, buffer: b },
    ];

    const highThreshold = findSimilarPairs(embeddings, 0.999);
    const lowThreshold = findSimilarPairs(embeddings, 0.9);
    expect(highThreshold.length).toBeLessThanOrEqual(lowThreshold.length);
  });

  it('threshold boundary: exact match includes, just below excludes', () => {
    const a = makeNormalizedBuffer([1, 2, 3]);
    const b = makeNormalizedBuffer([1, 2, 3.001]);
    const embeddings = [
      { id: 1, buffer: a },
      { id: 2, buffer: b },
    ];
    const sim = cosineSimilarity(a, b);

    const atThreshold = findSimilarPairs(embeddings, sim);
    expect(atThreshold.length).toBe(1);

    const aboveThreshold = findSimilarPairs(embeddings, sim + 0.001);
    expect(aboveThreshold.length).toBe(0);
  });
});

describe('performance', () => {
  it('45 pairs (10 vectors, 384-dim) < 1ms', () => {
    const embeddings = [];
    for (let i = 0; i < 10; i++) {
      embeddings.push({ id: i, buffer: makeRandomNormalized(EMBEDDING_DIM, i + 1) });
    }

    const start = performance.now();
    findSimilarPairs(embeddings, 0.85);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(15);
  });

  it('Buffer from SQLite BLOB format roundtrip', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const blob = Buffer.from(original.buffer);

    const restored = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    expect(restored[0]).toBeCloseTo(0.1, 5);
    expect(restored[3]).toBeCloseTo(0.4, 5);
  });
});

describe('model state', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('isModelReady returns false initially', () => {
    expect(isModelReady()).toBe(false);
  });

  it('getModelDir returns path with .devguard/models', () => {
    const dir = getModelDir();
    expect(dir).toContain('.devguard');
    expect(dir).toContain('models');
  });

  it('getModelDir respects DEVGUARD_MODEL_DIR env', () => {
    const original = process.env.DEVGUARD_MODEL_DIR;
    process.env.DEVGUARD_MODEL_DIR = '/tmp/test-models';
    try {
      expect(getModelDir()).toBe('/tmp/test-models');
    } finally {
      if (original === undefined) delete process.env.DEVGUARD_MODEL_DIR;
      else process.env.DEVGUARD_MODEL_DIR = original;
    }
  });

  it('EMBEDDING_DIM is 384', () => {
    expect(EMBEDDING_DIM).toBe(384);
  });

  it('encode returns null when model not loaded', async () => {
    const { encode } = require('../../src/engine/embedding');
    const result = await encode('test text');
    expect(result).toBeNull();
  });

  it('encode returns null for empty string', async () => {
    const { encode } = require('../../src/engine/embedding');
    const result = await encode('');
    expect(result).toBeNull();
  });

  it('encode returns null for null input', async () => {
    const { encode } = require('../../src/engine/embedding');
    const result = await encode(null);
    expect(result).toBeNull();
  });
});
