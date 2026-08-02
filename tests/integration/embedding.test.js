import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// cycle:embedding retired 2026-08: 0 real-world TPs ever vs 73 classified FPs. All of
// them come from its default-ON era (Apr–Jul 2026); after the 2026-07-01 opt-in gate it
// never fired again, and its signal overlaps diff_match.
// This suite pins two things at the integration level:
//   1. RETIREMENT — the exact synthetic input that was the detector's showcase TP
//      produces no embedding_match, even when a legacy user config re-enables it.
//   2. INFRA SURVIVES — embeddings are still stored and readable (feature clustering
//      and the post-compact summary depend on that path; retiring the detector must
//      not starve them).

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

// The retired detector's old showcase input: 3 near-identical embeddings on the
// SAME file — everything it needed to warn.
function seedShowcaseChanges(db) {
  const baseVec = [0.5, 0.3, 0.8, 0.1, 0.6, 0.2, 0.9, 0.4];
  const vecs = [
    makeNormalizedBuffer(baseVec),
    makeNormalizedBuffer(baseVec.map((v, i) => v + (i % 2 === 0 ? 0.01 : -0.01))),
    makeNormalizedBuffer(baseVec.map((v, i) => v + (i % 2 === 0 ? -0.01 : 0.02))),
  ];
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const cid = db.insertChange({
      session_id: 'test-session', file: 'src/a.js', action: 'Edit',
      description: `fix timeout attempt ${i}`,
      diff_text: `setTimeout(fn, ${15000 * (i + 1)})`,
    });
    db.updateChangeEmbedding(cid, vecs[i]);
    ids.push(cid);
  }
  return ids;
}

describe('Integration: embedding detector retired', () => {
  it('RETIREMENT: the old showcase input produces no embedding_match, even with legacy config flags', () => {
    const { db: dbMod, preEdit, config: configMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');
    seedShowcaseChanges(db);

    const config = configMod.loadConfig(projectDir);
    // Legacy user configs may still carry the retired keys; they must be inert.
    config.embedding_detector_enabled = true;
    config.embedding_similarity_threshold = 0.5;

    const results = preEdit.runPipeline({
      db, filePath: 'src/a.js', oldString: 'setTimeout(fn, 60000)',
      sessionId: 'test-session', config, projectPath: projectDir, lineRanges: null,
    }, preEdit.MIDDLEWARES);

    expect(results.map(r => r.type)).not.toContain('embedding_match');
    dbMod.closeDb();
  });

  it('loadConfig no longer surfaces the retired detector keys', () => {
    const { config: configMod } = loadModules();
    // A stale devguard.config.yaml setting the retired keys is silently ignored
    // (loadConfig only copies keys it validates).
    fs.writeFileSync(path.join(projectDir, 'devguard.config.yaml'),
      'embedding_detector_enabled: true\nembedding_similarity_threshold: 0.5\n');
    const config = configMod.loadConfig(projectDir);
    expect(config.embedding_detector_enabled).toBeUndefined();
    expect(config.embedding_similarity_threshold).toBeUndefined();
    expect(config.embedding_enabled).toBe(true); // infra flag untouched
  });

  it('INFRA SURVIVES: embeddings are still stored and readable for clustering/summary', () => {
    const { db: dbMod } = loadModules();
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');
    seedShowcaseChanges(db);

    const recent = db.getRecentEmbeddings('test-session', 10);
    expect(recent.length).toBe(3);
    expect(Buffer.isBuffer(recent[0].description_embedding)).toBe(true);
    dbMod.closeDb();
  });
});
