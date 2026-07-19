import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
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

function loadPostCompact() {
  delete require.cache[require.resolve('../../src/hooks/post-compact')];
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/hooks/post-compact');
}

function freshDb() {
  const db = loadDb();
  const proxy = db.getDb('/test/project');
  proxy.insertSession('test-session');
  return proxy;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-pc-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/hooks/post-compact')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

describe('post-compact.js — buildSummary', () => {
  it('returns null when DB is empty', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    expect(buildSummary(proxy, 'test-session')).toBeNull();
  });

  it('includes open issues in summary', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    proxy.insertIssue({ title: 'OAuth timeout', status: 'open' });
    const summary = buildSummary(proxy, 'test-session');
    expect(summary).toContain('OAuth timeout');
    expect(summary).toContain('Active issues');
  });

  it('includes protected zones in summary', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    const issueId = proxy.insertIssue({ title: 'fix' });
    const changeId = proxy.insertChange({ file: 'auth.js' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: 'auth.js',
      reason: 'token refresh', temp_protection: 0, protected_commit: 'a'.repeat(40),
    });
    const summary = buildSummary(proxy, 'test-session');
    expect(summary).toContain('auth.js');
    expect(summary).toContain('Protected fixes');
  });

  it('includes last error in summary', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    proxy.insertErrorOutput({
      error_string: 'TypeError: Cannot read property of null',
      error_hash: 'abc123',
      session_id: 'test-session',
    });
    const summary = buildSummary(proxy, 'test-session');
    expect(summary).toContain('TypeError');
    expect(summary).toContain('Last error');
  });

  it('includes repeated file edits in summary', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    for (let i = 0; i < 4; i++) {
      proxy.insertChange({ file: 'auth.js', session_id: 'test-session' });
    }
    const summary = buildSummary(proxy, 'test-session');
    expect(summary).toContain('auth.js');
    expect(summary).toContain('4x');
  });

  it('produces combined summary with all data types', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    proxy.insertIssue({ title: 'MCP timeout', status: 'open' });
    proxy.insertErrorOutput({
      error_string: 'Connection refused', error_hash: 'err1', session_id: 'test-session',
    });
    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: 'pipeline.ts', session_id: 'test-session' });
    }
    const summary = buildSummary(proxy, 'test-session');
    expect(summary).toContain('DevGuard Session Summary:');
    expect(summary).toContain('MCP timeout');
    expect(summary).toContain('Connection refused');
    expect(summary).toContain('pipeline.ts');
  });

  it('limits issues to 3', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();
    for (let i = 0; i < 5; i++) {
      proxy.insertIssue({ title: `Issue ${i}`, status: 'open' });
    }
    const summary = buildSummary(proxy, 'test-session');
    expect(summary).toContain('Issue 0');
    expect(summary).toContain('Issue 2');
    expect(summary).not.toContain('Issue 4');
  });

  it('QA #4: two consecutive compacts — second overwrites first', () => {
    const proxy = freshDb();
    proxy.setPendingSummary('test-session', 'first summary');
    proxy.setPendingSummary('test-session', 'second summary');
    const consumed = proxy.consumePendingSummary('test-session');
    expect(consumed).toBe('second summary');
    expect(proxy.consumePendingSummary('test-session')).toBeNull();
  });

  it('includes embedding cluster info via appendEmbeddingInfo', () => {
    const proxy = freshDb();
    const { buildSummary, appendEmbeddingInfo } = loadPostCompact();

    function makeNormalizedBuffer(arr) {
      const f32 = new Float32Array(arr);
      let norm = 0;
      for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
      return Buffer.from(f32.buffer);
    }

    const vec = makeNormalizedBuffer([1, 2, 3, 4]);
    for (let i = 0; i < 3; i++) {
      const cid = proxy.insertChange({
        session_id: 'test-session', file: `f${i}.js`, action: 'Edit',
        description: 'fix timeout interval',
      });
      proxy.updateChangeEmbedding(cid, vec);
    }

    const base = buildSummary(proxy, 'test-session');
    const full = appendEmbeddingInfo(proxy, 'test-session', base, { similarity_threshold: 0.85 });
    expect(full).toContain('Recurring pattern');
    expect(full).toContain('similar pairs');
  });

  it('buildSummary alone does NOT include embedding info', () => {
    const proxy = freshDb();
    const { buildSummary } = loadPostCompact();

    function makeNormalizedBuffer(arr) {
      const f32 = new Float32Array(arr);
      let norm = 0;
      for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
      return Buffer.from(f32.buffer);
    }

    const vec = makeNormalizedBuffer([1, 2, 3, 4]);
    for (let i = 0; i < 3; i++) {
      const cid = proxy.insertChange({
        session_id: 'test-session', file: `f${i}.js`, action: 'Edit',
        description: 'fix timeout interval',
      });
      proxy.updateChangeEmbedding(cid, vec);
    }

    const summary = buildSummary(proxy, 'test-session');
    if (summary) {
      expect(summary).not.toContain('Recurring pattern');
    }
  });

  it('appendEmbeddingInfo uses config threshold', () => {
    const proxy = freshDb();
    const { appendEmbeddingInfo } = loadPostCompact();

    function makeNormalizedBuffer(arr) {
      const f32 = new Float32Array(arr);
      let norm = 0;
      for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
      return Buffer.from(f32.buffer);
    }

    const vecs = [
      makeNormalizedBuffer([1, 0, 0, 0]),
      makeNormalizedBuffer([0, 1, 0, 0]),
      makeNormalizedBuffer([0, 0, 1, 0]),
    ];
    for (let i = 0; i < vecs.length; i++) {
      const cid = proxy.insertChange({
        session_id: 'test-session', file: `f${i}.js`, action: 'Edit',
        description: `desc ${i}`,
      });
      proxy.updateChangeEmbedding(cid, vecs[i]);
    }

    const result = appendEmbeddingInfo(proxy, 'test-session', null, { similarity_threshold: 0.85 });
    expect(result).toBeNull();
  });
});

describe('post-compact.js — main() session attribution (g2)', () => {
  it('stores the pending summary under input.session_id, not the newest session row', () => {
    // The WRITE side of g2: post-compact must pin the pending summary to the
    // session that triggered compaction (input.session_id), NOT getLatestSession()
    // — a concurrent headless `claude -p` can insert a newer 'sessions' row.
    const HOOK = require.resolve('../../src/hooks/post-compact');
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-pc-proj-'));

    let db = loadDb();
    let proxy = db.getDb(projectDir);
    proxy.insertSession('submitter');
    proxy.insertIssue({ title: 'OAuth timeout', status: 'open' }); // makes buildSummary non-null
    proxy.insertSession('headless-newer'); // decoy: newest row, what getLatestSession() would pick
    db.closeDb();
    delete require.cache[require.resolve('../../src/engine/db')];

    execFileSync('node', [HOOK], {
      input: JSON.stringify({ cwd: projectDir, session_id: 'submitter' }),
      encoding: 'utf-8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0' },
    });

    db = loadDb();
    proxy = db.getDb(projectDir);
    // Fixed code stores under 'submitter'; buggy (getLatestSession) code would
    // store under 'headless-newer', leaving 'submitter' empty -> RED.
    expect(proxy.consumePendingSummary('submitter')).toContain('Active issues');
    expect(proxy.consumePendingSummary('headless-newer')).toBeNull();
    db.closeDb();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
  });
});
