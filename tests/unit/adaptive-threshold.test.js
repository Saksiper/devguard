import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;
let projectDir;

function loadModules() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/adaptive-threshold')];
  return {
    db: require('../../src/engine/db'),
    threshold: require('../../src/engine/adaptive-threshold'),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-adapt-'));
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try {
    const { db } = loadModules();
    db.closeDb();
  } catch { /* */ }
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getSubcategory', () => {
  // file_match subcategory test removed with checkFileMatch v0.2.2
  it('extracts hash prefix for error_hash', () => {
    const { threshold } = loadModules();
    expect(threshold.getSubcategory('cycle:error_hash', { errorHash: 'abcd1234' })).toBe('abcd');
  });

  it('extracts framework for test_repeat', () => {
    const { threshold } = loadModules();
    expect(threshold.getSubcategory('cycle:test_repeat', { testFramework: 'vitest' })).toBe('vitest');
  });

  it('returns null for unknown middleware', () => {
    const { threshold } = loadModules();
    expect(threshold.getSubcategory('cycle:diff_match', {})).toBeNull();
  });

  it('returns null for null context', () => {
    const { threshold } = loadModules();
    expect(threshold.getSubcategory('cycle:file_match', null)).toBeNull();
  });
});

describe('getAdaptiveMinOccurrences', () => {
  it('returns static default when no data', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    const result = threshold.getAdaptiveMinOccurrences(proxy, 'cycle:file_match', '.js', 3);
    expect(result).toBe(3);
    db.closeDb();
  });

  it('returns static default when sample_count < MIN_SAMPLE_COUNT', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.upsertThresholdParams('cycle:file_match', '.js', 3.0, 1.0, 3);
    const result = threshold.getAdaptiveMinOccurrences(proxy, 'cycle:file_match', '.js', 3);
    expect(result).toBe(3);
    db.closeDb();
  });

  it('returns adaptive threshold when enough samples', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    // High alpha (many TPs) → sample likely > 0.5 → lower threshold
    proxy.upsertThresholdParams('cycle:file_match', '.js', 50.0, 2.0, 52);
    const result = threshold.getAdaptiveMinOccurrences(proxy, 'cycle:file_match', '.js', 3);
    // With alpha=50, beta=2, mean=0.96 → very likely > 0.5 → returns 2
    expect(result).toBe(2);
    db.closeDb();
  });

  it('returns higher threshold when many FPs', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    // High beta (many FPs) → sample likely < 0.5 → higher threshold
    proxy.upsertThresholdParams('cycle:file_match', '.js', 2.0, 50.0, 52);
    const result = threshold.getAdaptiveMinOccurrences(proxy, 'cycle:file_match', '.js', 3);
    expect(result).toBe(4);
    db.closeDb();
  });
});

describe('updateThreshold', () => {
  it('creates new entry for TP', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    threshold.updateThreshold(proxy, 'cycle:file_match', '.js', true);
    const params = proxy.getThresholdParams('cycle:file_match', '.js');
    expect(params).not.toBeNull();
    expect(params.alpha).toBe(2.0);
    expect(params.beta).toBe(1.0);
    expect(params.sample_count).toBe(1);
    db.closeDb();
  });

  it('creates new entry for FP', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    threshold.updateThreshold(proxy, 'cycle:file_match', '.js', false);
    const params = proxy.getThresholdParams('cycle:file_match', '.js');
    expect(params.alpha).toBe(1.0);
    expect(params.beta).toBe(2.0);
    expect(params.sample_count).toBe(1);
    db.closeDb();
  });

  it('increments existing entry', () => {
    const { db, threshold } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.upsertThresholdParams('cycle:file_match', '.js', 5.0, 3.0, 7);
    threshold.updateThreshold(proxy, 'cycle:file_match', '.js', true);
    const params = proxy.getThresholdParams('cycle:file_match', '.js');
    expect(params.alpha).toBe(6.0);
    expect(params.beta).toBe(3.0);
    expect(params.sample_count).toBe(8);
    db.closeDb();
  });
});

describe('multi-tenant isolation', () => {
  it('different projects have separate threshold params', () => {
    const { db } = loadModules();
    const proj1 = path.join(tmpDir, 'proj1');
    const proj2 = path.join(tmpDir, 'proj2');
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    const proxy1 = db.getDb(proj1);
    const proxy2 = db.getDb(proj2);

    proxy1.upsertThresholdParams('cycle:file_match', '.js', 10.0, 1.0, 11);
    proxy2.upsertThresholdParams('cycle:file_match', '.js', 1.0, 10.0, 11);

    const p1 = proxy1.getThresholdParams('cycle:file_match', '.js');
    const p2 = proxy2.getThresholdParams('cycle:file_match', '.js');

    expect(p1.alpha).toBe(10.0);
    expect(p2.alpha).toBe(1.0);
    db.closeDb();
  });
});

describe('betaSample', () => {
  it('returns value between 0 and 1', () => {
    const { threshold } = loadModules();
    for (let i = 0; i < 100; i++) {
      const sample = threshold.betaSample(2.0, 2.0);
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it('skews high with large alpha', () => {
    const { threshold } = loadModules();
    let sum = 0;
    const n = 100;
    for (let i = 0; i < n; i++) {
      sum += threshold.betaSample(50.0, 2.0);
    }
    expect(sum / n).toBeGreaterThan(0.7);
  });

  it('skews low with large beta', () => {
    const { threshold } = loadModules();
    let sum = 0;
    const n = 100;
    for (let i = 0; i < n; i++) {
      sum += threshold.betaSample(2.0, 50.0);
    }
    expect(sum / n).toBeLessThan(0.3);
  });
});
