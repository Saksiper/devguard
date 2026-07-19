import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

let tmpDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-audit-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL lock */ }
  }
});

describe('Multi-tenant audit — cross-project data isolation', () => {
  it('changes: projectA data does not leak to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertChange({ file: 'alpha-secret.js', description: 'alpha change' });
    proxyB.insertChange({ file: 'beta-only.js', description: 'beta change' });

    const alphaChanges = proxyA.getChanges();
    const betaChanges = proxyB.getChanges();

    expect(alphaChanges).toHaveLength(1);
    expect(alphaChanges[0].file).toBe('alpha-secret.js');
    expect(betaChanges).toHaveLength(1);
    expect(betaChanges[0].file).toBe('beta-only.js');
  });

  it('backfill: same tool_use_id in two projects stays isolated (partial unique index is per project_path)', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    // Same opaque tool_use_id imported into both projects must NOT conflict and
    // must stay isolated: each getDb sees only its own change row.
    const idA = proxyA.insertChange({ file: 'alpha.js', description: 'A', tool_use_id: 'toolu_SHARED', source: 'backfill' });
    const idB = proxyB.insertChange({ file: 'beta.js', description: 'B', tool_use_id: 'toolu_SHARED', source: 'backfill' });
    expect(idA).toBeGreaterThan(0);
    expect(idB).toBeGreaterThan(0);

    const aRows = proxyA.getChanges();
    const bRows = proxyB.getChanges();
    expect(aRows).toHaveLength(1);
    expect(aRows[0].file).toBe('alpha.js');
    expect(bRows).toHaveLength(1);
    expect(bRows[0].file).toBe('beta.js');

    // NOTE: backfill_cursor is INTENTIONALLY transcript-global (no project_path
    // filter) — one transcript can span multiple cwds, so the read offset is a
    // transcript-level fact, not a project-level one. Both proxies share it.
    proxyA.setBackfillCursor('/shared/transcript.jsonl', 512);
    expect(proxyB.getBackfillCursor('/shared/transcript.jsonl')).toBe(512);
  });

  it('issues: projectA issues not visible to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertIssue({ title: 'alpha bug' });
    proxyB.insertIssue({ title: 'beta bug' });

    expect(proxyA.getIssues()).toHaveLength(1);
    expect(proxyA.getIssues()[0].title).toBe('alpha bug');
    expect(proxyB.getIssues()).toHaveLength(1);
    expect(proxyB.getIssues()[0].title).toBe('beta bug');
  });

  it('error_outputs: projectA errors not visible to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertErrorOutput({ error_string: 'alpha err', error_hash: 'h-a' });
    proxyB.insertErrorOutput({ error_string: 'beta err', error_hash: 'h-b' });

    const aErrors = proxyA.getErrorOutputs();
    const bErrors = proxyB.getErrorOutputs();
    expect(aErrors).toHaveLength(1);
    expect(aErrors[0].error_hash).toBe('h-a');
    expect(bErrors).toHaveLength(1);
    expect(bErrors[0].error_hash).toBe('h-b');
  });

  it('sessions: projectA sessions not visible to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertSession('sess-alpha');
    proxyB.insertSession('sess-beta');

    expect(proxyA.getLatestSession().session_id).toBe('sess-alpha');
    expect(proxyB.getLatestSession().session_id).toBe('sess-beta');
    expect(proxyA.getSessionCount()).toBe(1);
    expect(proxyB.getSessionCount()).toBe(1);
  });

  it('protected_zones: projectA zones not visible to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    const issueA = proxyA.insertIssue({ title: 'a' });
    const changeA = proxyA.insertChange({ file: 'a.js' });
    proxyA.insertProtectedZone({ issue_id: issueA, change_id: changeA, file: 'a.js' });

    const issueB = proxyB.insertIssue({ title: 'b' });
    const changeB = proxyB.insertChange({ file: 'b.js' });
    proxyB.insertProtectedZone({ issue_id: issueB, change_id: changeB, file: 'b.js' });

    expect(proxyA.getProtectedZones()).toHaveLength(1);
    expect(proxyA.getProtectedZones()[0].file).toBe('a.js');
    expect(proxyB.getProtectedZones()).toHaveLength(1);
    expect(proxyB.getProtectedZones()[0].file).toBe('b.js');
  });

  it('FTS5: projectA content not returned in projectB search', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertChange({ file: 'a.js', description: 'unique alpha keyword quantum' });
    proxyB.insertChange({ file: 'b.js', description: 'beta only content' });

    const aResults = proxyA.searchFts('quantum');
    const bResults = proxyB.searchFts('quantum');
    expect(aResults).toHaveLength(1);
    expect(bResults).toHaveLength(0);
  });

  it('blame_cache: projectA cache not visible to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertBlameCache('shared/file.js', 'abc123', '{"alpha":"data"}');
    proxyB.insertBlameCache('shared/file.js', 'abc123', '{"beta":"data"}');

    const cacheA = proxyA.getBlameCache('shared/file.js', 'abc123');
    const cacheB = proxyB.getBlameCache('shared/file.js', 'abc123');
    expect(cacheA.blame_data).toBe('{"alpha":"data"}');
    expect(cacheB.blame_data).toBe('{"beta":"data"}');
  });

  it('blame_cache TTL: projectA cleanup does not affect projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');
    const raw = db.openDb();

    raw.prepare(
      "INSERT INTO blame_cache (project_path, file_path, commit_hash, blame_data, created_at) VALUES (?, ?, ?, ?, datetime('now', '-10 days'))"
    ).run('/project/alpha', 'old.js', 'old', '{}');
    raw.prepare(
      "INSERT INTO blame_cache (project_path, file_path, commit_hash, blame_data, created_at) VALUES (?, ?, ?, ?, datetime('now', '-10 days'))"
    ).run('/project/beta', 'old.js', 'old', '{}');

    proxyA.deleteOldBlameCacheEntries(7);

    expect(proxyA.getBlameCache('old.js', 'old')).toBeNull();
    expect(proxyB.getBlameCache('old.js', 'old')).not.toBeNull();
  });

  it('FIFO: per-project limit, not global', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    for (let i = 0; i < 5; i++) proxyA.insertChange({ file: `a${i}.js` });
    for (let i = 0; i < 5; i++) proxyB.insertChange({ file: `b${i}.js` });

    proxyA.runFifo(3);

    expect(proxyA.getChangeCount()).toBe(3);
    expect(proxyB.getChangeCount()).toBe(5);
  });

  it('deleteByProjectPath: cascade deletes only target project', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertSession('s-a');
    proxyA.insertChange({ file: 'a.js' });
    proxyA.insertIssue({ title: 'a-issue' });
    proxyA.insertErrorOutput({ error_string: 'a-err', error_hash: 'ha' });

    proxyB.insertSession('s-b');
    proxyB.insertChange({ file: 'b.js' });
    proxyB.insertIssue({ title: 'b-issue' });
    proxyB.insertErrorOutput({ error_string: 'b-err', error_hash: 'hb' });

    proxyA.deleteByProjectPath('/project/alpha');

    expect(proxyA.getChanges()).toHaveLength(0);
    expect(proxyA.getIssues()).toHaveLength(0);
    expect(proxyA.getErrorOutputs()).toHaveLength(0);
    expect(proxyA.getLatestSession()).toBeNull();

    expect(proxyB.getChanges()).toHaveLength(1);
    expect(proxyB.getIssues()).toHaveLength(1);
    expect(proxyB.getErrorOutputs()).toHaveLength(1);
    expect(proxyB.getLatestSession()).not.toBeNull();
  });

  it('getDistinctProjectPaths: lists all projects with sessions', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');
    const proxyC = db.getDb('/project/gamma');

    proxyA.insertSession('s1');
    proxyB.insertSession('s2');
    proxyC.insertSession('s3');

    const paths = proxyA.getDistinctProjectPaths();
    expect(paths).toContain('/project/alpha');
    expect(paths).toContain('/project/beta');
    expect(paths).toContain('/project/gamma');
    expect(paths).toHaveLength(3);
  });

  it('hasRecentDetectionForFile does not leak detections across projects', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertSession('s-same');
    proxyB.insertSession('s-same'); // intentional same session_id to probe isolation

    proxyA.insertDetection({
      session_id: 's-same', file: 'app.js', middleware_id: 'cycle:file_match',
      decision: 'warn', level: 1, type: 'file_match', confidence: 1, message: 'x',
    });

    // Project A sees its own detection → cooldown active
    expect(proxyA.hasRecentDetectionForFile('s-same', 'app.js', 'cycle:file_match', 3)).toBe(true);
    // Project B has no such detection → cooldown inactive
    expect(proxyB.hasRecentDetectionForFile('s-same', 'app.js', 'cycle:file_match', 3)).toBe(false);
  });

  it('notes: projectA notes/head not visible to projectB, supersede stays isolated', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    const aId = proxyA.insertNote({ file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude', confidence_level: 3, note_text: 'alpha note' });
    proxyB.insertNote({ file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude', confidence_level: 3, note_text: 'beta note' });

    expect(proxyA.getHeadNoteByNode('ui_ux/filter').note_text).toBe('alpha note');
    expect(proxyB.getHeadNoteByNode('ui_ux/filter').note_text).toBe('beta note');
    expect(proxyA.getNotes({ node_id: 'ui_ux/filter' })).toHaveLength(1);
    expect(proxyB.getNotes({ node_id: 'ui_ux/filter' })).toHaveLength(1);

    // supersede + merge in A must not touch B's head
    const aId2 = proxyA.insertNote({ file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude', confidence_level: 3, note_text: 'alpha v2' });
    proxyA.supersedePriorHead('ui_ux/filter', aId2);
    expect(aId).toBeGreaterThan(0);
    expect(proxyA.getHeadNoteByNode('ui_ux/filter').id).toBe(aId2);
    expect(proxyB.getHeadNoteByNode('ui_ux/filter').note_text).toBe('beta note'); // unaffected
  });

  it('features: same node_id coexists across projects via UNIQUE(project_path, node_id)', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    function makeBuf(arr) {
      const f = new Float32Array(arr);
      let n = 0; for (let i = 0; i < f.length; i++) n += f[i] * f[i];
      n = Math.sqrt(n); if (n > 0) for (let i = 0; i < f.length; i++) f[i] /= n;
      return Buffer.from(f.buffer);
    }

    // The SAME node_id ("security/auth") must be insertable in BOTH projects. If the
    // schema used node_id-only uniqueness (roadmap's wrong spec) the second insert
    // would throw SQLITE_CONSTRAINT_UNIQUE.
    proxyA.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: makeBuf([1, 0, 0, 0]) });
    proxyB.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: makeBuf([0, 1, 0, 0]) });

    const fa = proxyA.getFeature('security/auth');
    const fb = proxyB.getFeature('security/auth');
    expect(fa).not.toBeNull();
    expect(fb).not.toBeNull();
    expect(fa.member_count).toBe(1);
    expect(fb.member_count).toBe(1);

    // Isolation: a second member in A must not touch B's row/centroid.
    proxyA.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: makeBuf([1, 1, 0, 0]) });
    expect(proxyA.getFeature('security/auth').member_count).toBe(2);
    expect(proxyB.getFeature('security/auth').member_count).toBe(1);

    // getFeaturesByContinent stays project-scoped.
    proxyA.upsertFeatureCentroid({ continent: 'security', country: 'crypto', node_id: 'security/crypto', embedding: makeBuf([0, 0, 1, 0]) });
    expect(proxyA.getFeaturesByContinent('security')).toHaveLength(2);
    expect(proxyB.getFeaturesByContinent('security')).toHaveLength(1);
  });
});

describe('QA #5: Cross-project protection bypass', () => {
  it('protected zone in project A is not visible from project B', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertSession('s1');
    proxyB.insertSession('s2');

    const issueId = proxyA.insertIssue({ title: 'OAuth fix' });
    const changeId = proxyA.insertChange({ file: 'auth.js' });
    proxyA.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      protected_commit: 'a'.repeat(40), temp_protection: 0,
    });

    expect(proxyA.hasProtectedFile('auth.js')).toBe(true);
    expect(proxyB.hasProtectedFile('auth.js')).toBe(false);
    expect(proxyA.getProtectedCommitsForFile('auth.js')).toHaveLength(1);
    expect(proxyB.getProtectedCommitsForFile('auth.js')).toHaveLength(0);
  });

});

describe('Multi-tenant audit — embedding isolation', () => {
  function makeNormalizedBuffer(arr) {
    const f32 = new Float32Array(arr);
    let norm = 0;
    for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
    return Buffer.from(f32.buffer);
  }

  it('getRecentEmbeddings: projectA embeddings not visible to projectB', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertSession('sess-a');
    proxyB.insertSession('sess-b');

    const vec = makeNormalizedBuffer([1, 2, 3, 4]);
    const cidA = proxyA.insertChange({ session_id: 'sess-a', file: 'a.js', action: 'Edit' });
    proxyA.updateChangeEmbedding(cidA, vec);

    const embA = proxyA.getRecentEmbeddings('sess-a', 10);
    const embB = proxyB.getRecentEmbeddings('sess-b', 10);

    expect(embA.length).toBe(1);
    expect(embB.length).toBe(0);

    db.closeDb();
  });

  it('updateChangeEmbedding: cannot update another project\'s change', () => {
    const db = loadDb();
    const proxyA = db.getDb('/project/alpha');
    const proxyB = db.getDb('/project/beta');

    proxyA.insertSession('sess-a');
    proxyB.insertSession('sess-b');

    const vec = makeNormalizedBuffer([1, 2, 3, 4]);
    const cidA = proxyA.insertChange({ session_id: 'sess-a', file: 'a.js', action: 'Edit' });

    const updated = proxyB.updateChangeEmbedding(cidA, vec);
    expect(updated).toBe(0);

    const embA = proxyA.getRecentEmbeddings('sess-a', 10);
    expect(embA.length).toBe(0);

    db.closeDb();
  });
});
