import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-embed-int-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

function loadModules() {
  for (const mod of [
    '../../src/engine/db',
    '../../src/engine/sanitize',
    '../../src/engine/debug-log',
    '../../src/engine/config',
    '../../src/engine/cycle-detector',
    '../../src/engine/line-resolver',
    '../../src/engine/protection',
    '../../src/engine/blame-cache',
    '../../src/engine/embedding',
    '../../src/hooks/pre-edit',
    '../../src/hooks/post-compact',
  ]) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* ok */ }
  }
  return {
    db: require('../../src/engine/db'),
    preEdit: require('../../src/hooks/pre-edit'),
    embedding: require('../../src/engine/embedding'),
    config: require('../../src/engine/config'),
  };
}

function makeNormalizedBuffer(arr) {
  const f32 = new Float32Array(arr);
  let norm = 0;
  for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
  return Buffer.from(f32.buffer);
}

describe('Integration: Embedding L3 cycle detection', () => {
  it('ACCEPTANCE: detects semantically similar changes (same approach, different words)', () => {
    const { db: dbMod, preEdit, config: configMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    // Simulate 3 changes that are "same approach with different words"
    // In production, embeddings would come from the model. Here we use synthetic vectors
    // that are very similar (cosine > 0.85) to simulate semantic similarity.
    const baseVec = [0.5, 0.3, 0.8, 0.1, 0.6, 0.2, 0.9, 0.4];
    const change1Vec = makeNormalizedBuffer(baseVec);
    const change2Vec = makeNormalizedBuffer(baseVec.map((v, i) => v + (i % 2 === 0 ? 0.01 : -0.01)));
    const change3Vec = makeNormalizedBuffer(baseVec.map((v, i) => v + (i % 2 === 0 ? -0.01 : 0.02)));

    // Same file: a cycle is rework of the same target (cross-file pairs are
    // ignored since the 2026-06 embedding FP fix)
    const cid1 = db.insertChange({
      session_id: 'test-session', file: 'src/a.js', action: 'Edit',
      description: 'fix timeout by increasing interval to 30s',
      diff_text: 'setTimeout(fn, 15000)',
    });
    db.updateChangeEmbedding(cid1, change1Vec);

    const cid2 = db.insertChange({
      session_id: 'test-session', file: 'src/a.js', action: 'Edit',
      description: 'resolve timeout issue with larger interval 45s',
      diff_text: 'setTimeout(fn, 30000)',
    });
    db.updateChangeEmbedding(cid2, change2Vec);

    const cid3 = db.insertChange({
      session_id: 'test-session', file: 'src/a.js', action: 'Edit',
      description: 'address timeout problem extending interval to 60s',
      diff_text: 'setTimeout(fn, 45000)',
    });
    db.updateChangeEmbedding(cid3, change3Vec);

    const config = configMod.loadConfig(projectDir);
    config.embedding_detector_enabled = true; // S3.4 (Q1): detector gated OFF by default
    const ctx = {
      db,
      filePath: 'src/a.js',
      oldString: 'setTimeout(fn, 60000)',
      sessionId: 'test-session',
      config,
      projectPath: projectDir,
      lineRanges: null,
    };

    const results = preEdit.runPipeline(ctx, preEdit.MIDDLEWARES);

    // Should detect embedding match (L3)
    const embeddingResult = results.find(r => r.type === 'embedding_match');
    expect(embeddingResult).toBeDefined();
    expect(embeddingResult.level).toBe(3);
    expect(['warn', 'block']).toContain(embeddingResult.decision);
    expect(embeddingResult.message).toContain('Semantic similarity');

    // formatMessage should include the warning
    const msg = preEdit.formatMessage(results);
    expect(msg).toContain('Semantic similarity');

    dbMod.closeDb();
  });

  it('SHIP DEFAULT: L3 detector is OFF by default (opt-in) — no embedding_match without the flag', () => {
    // Same 3 semantically-similar same-file changes as the ACCEPTANCE test; the
    // ONLY difference is we do NOT enable embedding_detector_enabled. Documents
    // that out-of-the-box DevGuard does not fire L3 (S3.4 Q1 gate) — so any
    // "100% recall" figure that includes L3 is opt-in, not the ship default.
    const { db: dbMod, preEdit, config: configMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const baseVec = [0.5, 0.3, 0.8, 0.1, 0.6, 0.2, 0.9, 0.4];
    const vecs = [
      makeNormalizedBuffer(baseVec),
      makeNormalizedBuffer(baseVec.map((v, i) => v + (i % 2 === 0 ? 0.01 : -0.01))),
      makeNormalizedBuffer(baseVec.map((v, i) => v + (i % 2 === 0 ? -0.01 : 0.02))),
    ];
    for (let i = 0; i < 3; i++) {
      const cid = db.insertChange({
        session_id: 'test-session', file: 'src/a.js', action: 'Edit',
        description: `timeout attempt ${i}`,
      });
      db.updateChangeEmbedding(cid, vecs[i]);
    }

    const config = configMod.loadConfig(projectDir); // embedding_detector_enabled defaults to false
    expect(config.embedding_detector_enabled).toBe(false); // ship default
    const ctx = {
      db, filePath: 'src/a.js', oldString: 'setTimeout(fn, 60000)', sessionId: 'test-session',
      config, projectPath: projectDir, lineRanges: null,
    };

    const results = preEdit.runPipeline(ctx, preEdit.MIDDLEWARES);
    expect(results.find(r => r.type === 'embedding_match')).toBeUndefined();

    dbMod.closeDb();
  });

  it('L3 skips gracefully when no embeddings exist', () => {
    const { db: dbMod, preEdit, config: configMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    // Insert changes WITHOUT embeddings
    db.insertChange({ session_id: 'test-session', file: 'a.js', action: 'Edit', description: 'fix a' });
    db.insertChange({ session_id: 'test-session', file: 'a.js', action: 'Edit', description: 'fix b' });

    const config = configMod.loadConfig(projectDir);
    config.embedding_detector_enabled = true; // S3.4 (Q1): detector gated OFF by default
    const ctx = {
      db, filePath: 'a.js', oldString: 'x', sessionId: 'test-session',
      config, projectPath: projectDir, lineRanges: null,
    };

    const results = preEdit.runPipeline(ctx, preEdit.MIDDLEWARES);
    const embeddingResult = results.find(r => r.type === 'embedding_match');
    expect(embeddingResult).toBeUndefined();

    dbMod.closeDb();
  });

  it('embedding_match (L3) ignores cross-file pairs — same-file pairs below min_occurrences stay silent', () => {
    const { db: dbMod, preEdit, config: configMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    // 3 identical embeddings, but only one same-file pair (same.js × 2):
    // cross-file pairs no longer count toward min_occurrences
    const vec = makeNormalizedBuffer([1, 2, 3, 4]);
    const files = ['same.js', 'same.js', 'other.js'];
    for (let i = 0; i < 3; i++) {
      const cid = db.insertChange({
        session_id: 'test-session', file: files[i], action: 'Edit',
        description: `attempt ${i}`,
      });
      db.updateChangeEmbedding(cid, vec);
    }

    const config = configMod.loadConfig(projectDir);
    config.embedding_detector_enabled = true; // S3.4 (Q1): detector gated OFF by default
    const ctx = {
      db, filePath: 'same.js', oldString: 'x', sessionId: 'test-session',
      config, projectPath: projectDir, lineRanges: null,
    };

    const results = preEdit.runPipeline(ctx, preEdit.MIDDLEWARES);

    const types = results.map(r => r.type);
    expect(types).not.toContain('embedding_match');

    dbMod.closeDb();
  });

  it('empty session produces no L3 detection', () => {
    const { db: dbMod, preEdit, config: configMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const config = configMod.loadConfig(projectDir);
    config.embedding_detector_enabled = true; // S3.4 (Q1): detector gated OFF by default
    const ctx = {
      db, filePath: 'x.js', oldString: 'y', sessionId: 'test-session',
      config, projectPath: projectDir, lineRanges: null,
    };

    const results = preEdit.runPipeline(ctx, preEdit.MIDDLEWARES);
    expect(results.filter(r => r.type === 'embedding_match')).toHaveLength(0);

    dbMod.closeDb();
  });
});
