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
  delete require.cache[require.resolve('../../src/engine/auto-promote')];
  delete require.cache[require.resolve('../../src/engine/adaptive-threshold')];
  return {
    db: require('../../src/engine/db'),
    autoPromote: require('../../src/engine/auto-promote'),
  };
}

const defaultConfig = {
  auto_promote_enabled: true,
  auto_promote_tp_threshold: 5,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-promote-'));
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

describe('checkAutoPromote', () => {
  it('returns empty when no detections', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    const result = autoPromote.checkAutoPromote(proxy, defaultConfig);
    expect(result).toEqual([]);
    db.closeDb();
  });

  it('returns empty when below threshold', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess1');

    for (let i = 0; i < 4; i++) {
      const id = proxy.insertDetection({
        session_id: 'sess1',
        file: 'app.js',
        middleware_id: 'cycle:file_match',
        decision: 'warn',
        level: 1,
        type: 'file_match',
        confidence: 0.8,
        message: 'test',
      });
      proxy.classifyDetection(id, 'tp', null);
    }

    const result = autoPromote.checkAutoPromote(proxy, defaultConfig);
    expect(result).toEqual([]);
    db.closeDb();
  });

  it('returns promotable when >= threshold TPs', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess1');

    for (let i = 0; i < 5; i++) {
      const id = proxy.insertDetection({
        session_id: 'sess1',
        file: 'app.js',
        middleware_id: 'cycle:file_match',
        decision: 'warn',
        level: 1,
        type: 'file_match',
        confidence: 0.8,
        message: 'test',
      });
      proxy.classifyDetection(id, 'tp', null);
    }

    const result = autoPromote.checkAutoPromote(proxy, defaultConfig);
    expect(result).toHaveLength(1);
    expect(result[0].middlewareId).toBe('cycle:file_match');
    expect(result[0].tpCount).toBe(5);
    db.closeDb();
  });

  it('includes FP count in result', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess1');

    for (let i = 0; i < 5; i++) {
      const id = proxy.insertDetection({
        session_id: 'sess1', file: 'app.js', middleware_id: 'cycle:error_hash',
        decision: 'warn', level: 1, type: 'error_hash', confidence: 0.7, message: 't',
      });
      proxy.classifyDetection(id, 'tp', null);
    }
    for (let i = 0; i < 3; i++) {
      const id = proxy.insertDetection({
        session_id: 'sess1', file: 'app.js', middleware_id: 'cycle:error_hash',
        decision: 'warn', level: 1, type: 'error_hash', confidence: 0.5, message: 't',
      });
      proxy.classifyDetection(id, 'fp', null);
    }

    const result = autoPromote.checkAutoPromote(proxy, defaultConfig);
    expect(result).toHaveLength(1);
    expect(result[0].tpCount).toBe(5);
    expect(result[0].fpCount).toBe(3);
    db.closeDb();
  });
});

describe('applyAutoPromote', () => {
  it('returns 0 when disabled', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    const result = autoPromote.applyAutoPromote(proxy, { ...defaultConfig, auto_promote_enabled: false });
    expect(result).toBe(0);
    db.closeDb();
  });

  it('promotes to threshold_params', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess1');

    for (let i = 0; i < 6; i++) {
      const id = proxy.insertDetection({
        session_id: 'sess1', file: 'app.js', middleware_id: 'cycle:file_match',
        decision: 'warn', level: 1, type: 'file_match', confidence: 0.8, message: 'test',
      });
      proxy.classifyDetection(id, 'tp', null);
    }

    const promoted = autoPromote.applyAutoPromote(proxy, defaultConfig);
    expect(promoted).toBe(1);

    const params = proxy.getThresholdParams('cycle:file_match', '.js');
    expect(params).not.toBeNull();
    expect(params.alpha).toBe(6);
    expect(params.sample_count).toBe(6);
    db.closeDb();
  });

  it('is idempotent (no double-count)', () => {
    const { db, autoPromote } = loadModules();
    const proxy = db.getDb(projectDir);
    proxy.insertSession('sess1');

    for (let i = 0; i < 5; i++) {
      const id = proxy.insertDetection({
        session_id: 'sess1', file: 'app.js', middleware_id: 'cycle:file_match',
        decision: 'warn', level: 1, type: 'file_match', confidence: 0.8, message: 'test',
      });
      proxy.classifyDetection(id, 'tp', null);
    }

    autoPromote.applyAutoPromote(proxy, defaultConfig);
    const secondRun = autoPromote.applyAutoPromote(proxy, defaultConfig);
    expect(secondRun).toBe(0);
    db.closeDb();
  });
});

describe('multi-tenant isolation', () => {
  it('different projects have separate auto-promote', () => {
    const { db, autoPromote } = loadModules();
    const proj1 = path.join(tmpDir, 'proj1');
    const proj2 = path.join(tmpDir, 'proj2');
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    const proxy1 = db.getDb(proj1);
    proxy1.insertSession('s1');
    for (let i = 0; i < 5; i++) {
      const id = proxy1.insertDetection({
        session_id: 's1', file: 'a.js', middleware_id: 'cycle:file_match',
        decision: 'warn', level: 1, type: 'file_match', confidence: 0.8, message: 't',
      });
      proxy1.classifyDetection(id, 'tp', null);
    }

    const proxy2 = db.getDb(proj2);
    proxy2.insertSession('s2');
    proxy2.insertDetection({
      session_id: 's2', file: 'b.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 0.8, message: 't',
    });

    const r1 = autoPromote.checkAutoPromote(proxy1, defaultConfig);
    const r2 = autoPromote.checkAutoPromote(proxy2, defaultConfig);

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(0);
    db.closeDb();
  });
});

describe('getSubcategoryFromFile', () => {
  it('extracts file extension', () => {
    const { autoPromote } = loadModules();
    expect(autoPromote.getSubcategoryFromFile('app.js')).toBe('.js');
    expect(autoPromote.getSubcategoryFromFile('main.py')).toBe('.py');
    expect(autoPromote.getSubcategoryFromFile('/path/to/file.ts')).toBe('.ts');
  });

  it('returns null for no extension', () => {
    const { autoPromote } = loadModules();
    expect(autoPromote.getSubcategoryFromFile('Makefile')).toBeNull();
  });

  it('returns null for null', () => {
    const { autoPromote } = loadModules();
    expect(autoPromote.getSubcategoryFromFile(null)).toBeNull();
  });
});
