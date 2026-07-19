import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/user-prompt-submit.js');
const { resolveFeatureNodeId } = require('../../src/hooks/user-prompt-submit.js');
const { computeFileFingerprint } = require('../../src/engine/file-fingerprint.js');

// Unit-normalized Float32 Buffer (cosineSimilarity assumes unit vectors).
function vec(arr) {
  const f = new Float32Array(arr);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < f.length; i++) f[i] /= n;
  return Buffer.from(f.buffer);
}

let tmpDir;
let projectDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-ups-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
});

afterEach(() => {
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function ensureSession(sessionId = 'test-session') {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  proxy.insertSession(sessionId);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

// Inserts a bare 'sessions' row (a decoy "newest session", e.g. a concurrent
// headless `claude -p`). getLatestSession() returns whichever row has the
// highest id, so inserting this after the submitter makes it the latest.
function insertSessionRow(id) {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  db.getDb(projectDir).insertSession(id);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

function surfacedEvents() {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const rows = db.getDb(projectDir).getNoteEvents({ event_type: 'surfaced' });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return rows;
}

function setPending(sessionId, content) {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  proxy.setPendingSummary(sessionId, content);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

function seedNote(nodeId, noteText, extra = {}) {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  proxy.insertNote({ file: nodeId, node_id: nodeId, source: 'yol2_claude', confidence_level: 3, note_text: noteText, ...extra });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

// Learned bootstrap vocabulary: a features-table row born from the project's own
// edits (upsertFeatureCentroid is what assignFeature calls at edit time).
function seedFeature(nodeId) {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  const db = loadDb();
  const proxy = db.getDb(projectDir);
  const [continent, country] = nodeId.split('/');
  proxy.upsertFeatureCentroid({ continent, country, node_id: nodeId, embedding: null });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}

function writeConfig(content) {
  fs.writeFileSync(path.join(projectDir, 'devguard.config.yaml'), content);
}

function runHook(inputObj) {
  const input = JSON.stringify(inputObj);
  try {
    const stdout = execFileSync('node', [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tmpDir,
        DEVGUARD_DEBUG: '0',
      },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

describe('user-prompt-submit.js', () => {
  // Fallback-to-latest path: no session_id in the payload, so the hook must fall
  // back to getLatestSession(). This is the ONE UPS happy-path case that omits
  // session_id on purpose — all others pin it to match the real payload contract.
  it('injects pending summary when available (fallback to latest session)', () => {
    ensureSession();
    setPending('test-session', 'DevGuard Session Summary:\n- Test summary');

    const result = runHook({ cwd: projectDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toContain('DevGuard Session Summary');
    expect(output.hookSpecificOutput.additionalContext).toContain('Test summary');
  });

  it('returns empty response when no pending summary', () => {
    ensureSession();

    const result = runHook({ cwd: projectDir, session_id: 'test-session' });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('consumes pending summary (not available on second call)', () => {
    ensureSession();
    setPending('test-session', 'Test summary');

    runHook({ cwd: projectDir, session_id: 'test-session' });
    const result = runHook({ cwd: projectDir, session_id: 'test-session' });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('exits 0 gracefully when no session', () => {
    const result = runHook({ cwd: projectDir });
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 gracefully on invalid input', () => {
    const result = runHook({});
    expect(result.exitCode).toBe(0);
  });

  it('surfaces the head note when the prompt names a known feature', () => {
    ensureSession();
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter behavior' });
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('Made the filter case-insensitive.');
    expect(ctx).toContain('[DG-NOTE ui_ux/filter]');
  });

  it('instructs to leave a note when the prompt names a note-less feature the project itself created', () => {
    ensureSession();
    seedFeature('ui_ux/filter'); // learned vocabulary — no hardcoded keyword map

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'add a filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('[DG-NOTE ui_ux/filter]');
    expect(ctx.toLowerCase()).toContain('no prior note');
  });

  it('does NOT nudge for a feature this project has never worked on (no hardcoded vocabulary)', () => {
    ensureSession();
    // 'filter' used to be in a frozen demo keyword map and fired in ANY project.
    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'add a filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || '';
    expect(ctx).not.toContain('[DG-NOTE');
  });

  it('keeps pending summary first and appends feature note as a separate block', () => {
    ensureSession();
    setPending('test-session', 'DevGuard Session Summary:\n- foo');
    seedNote('ui_ux/filter', 'Prior filter note.');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'change the filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('DevGuard Session Summary');
    expect(ctx).toContain('Prior filter note.');
    expect(ctx.indexOf('DevGuard Session Summary')).toBeLessThan(ctx.indexOf('Prior filter note.'));
  });

  it('no feature note when the prompt has no known keyword', () => {
    ensureSession();

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'refactor the database layer' });
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  // --- V16: staleness re-verify annotation ---
  it('appends a re-verify warning when the note source file changed since capture', () => {
    ensureSession();
    const srcFile = path.join(projectDir, 'filter.js');
    fs.writeFileSync(srcFile, 'current filter code');
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.', {
      source_file: srcFile,
      code_fingerprint: 'deadbeef'.repeat(8), // 64 hex, does NOT match the file → stale
    });

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Made the filter case-insensitive.');
    expect(ctx.toLowerCase()).toContain('re-verify');
  });

  it('does NOT append a warning when the source file is unchanged since capture', () => {
    ensureSession();
    const srcFile = path.join(projectDir, 'filter.js');
    fs.writeFileSync(srcFile, 'stable filter code');
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.', {
      source_file: srcFile,
      code_fingerprint: computeFileFingerprint(srcFile), // matches → fresh
    });

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Made the filter case-insensitive.');
    expect(ctx.toLowerCase()).not.toContain('re-verify');
  });

  // --- S2.A: discrete labeled feature_note section ---
  it('S2.A: surfaced head note appears under a distinct labeled feature section', () => {
    ensureSession();
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('DevGuard Feature Note');
    expect(ctx).toContain('Made the filter case-insensitive.');
  });

  it('S2.A: feature header suppressed when only the pending channel has content', () => {
    ensureSession();
    setPending('test-session', 'DevGuard Session Summary:\n- only pending');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'refactor the database layer' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('DevGuard Session Summary');
    expect(ctx).not.toContain('DevGuard Feature Note');
  });

  it('S2.A: both channels present → pending, then labeled feature section, then the note', () => {
    ensureSession();
    setPending('test-session', 'DevGuard Session Summary:\n- foo');
    seedNote('ui_ux/filter', 'Prior filter note.');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'change the filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx.indexOf('DevGuard Session Summary')).toBeLessThan(ctx.indexOf('DevGuard Feature Note'));
    expect(ctx.indexOf('DevGuard Feature Note')).toBeLessThan(ctx.indexOf('Prior filter note.'));
  });

  it('S2.A: feature named but no head note → no empty labeled header', () => {
    ensureSession();
    seedFeature('ui_ux/filter'); // learned vocabulary — the project itself created this feature

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'add a filter' });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[DG-NOTE ui_ux/filter]');
    expect(ctx).not.toContain('DevGuard Feature Note');
  });

  // --- regression: session attribution (work item g2) ---
  // A concurrent headless `claude -p` can insert a NEWER 'sessions' row mid-turn.
  // The hook must attribute to the session that submitted THIS prompt
  // (input.session_id), NOT the newest row (getLatestSession).
  it('attributes the surfaced note_event to the submitting session, not the newest session row', () => {
    ensureSession('submitter');
    seedNote('ui_ux/filter', 'prior');
    insertSessionRow('headless-newer'); // decoy: newest 'sessions' row

    const result = runHook({ cwd: projectDir, session_id: 'submitter', prompt: 'tweak the filter' });
    expect(result.exitCode).toBe(0);

    const events = surfacedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('submitter');
  });

  it('consumes the pending summary of the submitting session, not the newest session row', () => {
    ensureSession('submitter');
    setPending('submitter', 'DevGuard Session Summary:\n- x');
    insertSessionRow('headless-newer'); // decoy: newest 'sessions' row

    const result = runHook({ cwd: projectDir, session_id: 'submitter', prompt: 'hello' });
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('DevGuard Session Summary');
  });

  // --- 2026-07-18: per-session surface cooldown ---
  // Live failure: the same node surfaced on EVERY prompt of a session (3× measured),
  // and each forced ack layered another bookkeeping note onto it (vocabulary ratchet).
  it('surfaces a node at most once per session (repeat prompt stays quiet)', () => {
    ensureSession();
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.');

    const r1 = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter behavior' });
    expect(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext).toContain('Made the filter case-insensitive.');

    const r2 = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'polish the filter styling' });
    const out2 = JSON.parse(r2.stdout);
    expect(out2.hookSpecificOutput?.additionalContext).toBeUndefined();
    expect(surfacedEvents()).toHaveLength(1);
  });

  it('a NEW session surfaces the same node again', () => {
    ensureSession('first');
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.');
    runHook({ cwd: projectDir, session_id: 'first', prompt: 'tweak the filter behavior' });

    insertSessionRow('second');
    const r2 = runHook({ cwd: projectDir, session_id: 'second', prompt: 'tweak the filter behavior' });
    expect(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext).toContain('Made the filter case-insensitive.');
    expect(surfacedEvents()).toHaveLength(2);
  });

  // --- intervention toggle (passive/active A/B mode) ---
  it('intervention_enabled=false: no context injected and NO surfaced event, even with a head note', () => {
    ensureSession();
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.');
    writeConfig('intervention_enabled: false\n');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter behavior' });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    // Passive: nothing surfaced to Claude
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
    // No phantom surface recorded
    expect(surfacedEvents()).toHaveLength(0);
  });

  it('intervention_enabled=false: pending summary is not injected either', () => {
    ensureSession();
    setPending('test-session', 'DevGuard Session Summary:\n- pending');
    writeConfig('intervention_enabled: false\n');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'hello there' });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('intervention_enabled=true (explicit): surfaces the note and records the surfaced event', () => {
    ensureSession();
    seedNote('ui_ux/filter', 'Made the filter case-insensitive.');
    writeConfig('intervention_enabled: true\n');

    const result = runHook({ cwd: projectDir, session_id: 'test-session', prompt: 'tweak the filter behavior' });
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('Made the filter case-insensitive.');
    expect(surfacedEvents()).toHaveLength(1);
  });
});

// --- S2.B ON-path wiring (in-process, fake encoder, NEVER loads the real model) ---
// Every subprocess test above runs DEFAULT-OFF, so the embedding branch — the config
// gate, the resolver require, the await and the threshold argument — had zero
// coverage: a wiring regression (wrong config key, dropped await, wrong threshold)
// would be invisible in CI. resolveFeatureNodeId is the seam main() calls; exercise
// both branches here with injected deps so no MiniLM load ever happens.
describe('user-prompt-submit resolveFeatureNodeId (S2.B branch wiring)', () => {
  const FEATURES = [
    { node_id: 'ui_ux/filter', centroid_embedding: vec([1, 0, 0, 0]) },
    { node_id: 'security/auth', centroid_embedding: vec([0, 1, 0, 0]) },
  ];
  const embDb = { getAllFeatures: () => FEATURES };
  const deps = (v) => ({ loadModel: async () => ({}), encode: async () => v });

  it('ON: takes the embedding branch and returns the global argmax node', async () => {
    const node = await resolveFeatureNodeId(embDb, 'log in please',
      { sphere_read_resolver_enabled: true, feature_cluster_threshold: 0.5 }, deps(vec([0.1, 1, 0, 0])));
    expect(node).toBe('security/auth');
  });

  it('ON: the threshold comes from config.feature_cluster_threshold (0.99 rejects a 0.707 match)', async () => {
    const node = await resolveFeatureNodeId(embDb, 'x',
      { sphere_read_resolver_enabled: true, feature_cluster_threshold: 0.99 }, deps(vec([1, 1, 0, 0])));
    expect(node).toBeNull();
  });

  it('index disabled: no hardcoded fallback — resolution is null without the embedding branch', async () => {
    const node = await resolveFeatureNodeId({}, 'tweak the filter behavior',
      { sphere_read_resolver_enabled: false, keyword_index_enabled: false }, undefined);
    expect(node).toBeNull();
  });

  it('DEFAULT: when the index defers, the learned bootstrap names a note-less feature from the features table', async () => {
    const db = {
      getNotes: () => [],
      getAllFeatures: () => [{ node_id: 'ui_ux/export', continent: 'ui_ux', country: 'export' }],
      getHeadNoteByNode: () => null,
    };
    const node = await resolveFeatureNodeId(db, 'fix the export button',
      { sphere_read_resolver_enabled: false }, undefined);
    expect(node).toBe('ui_ux/export');
  });

  it('DEFAULT: the learned bootstrap never returns a feature that already HAS a note (index decides those)', async () => {
    const db = {
      getNotes: () => [],
      getAllFeatures: () => [{ node_id: 'ui_ux/export', continent: 'ui_ux', country: 'export' }],
      getHeadNoteByNode: () => ({ id: 1, note_text: 'existing' }),
    };
    const node = await resolveFeatureNodeId(db, 'fix the export button',
      { sphere_read_resolver_enabled: false }, undefined);
    expect(node).toBeNull();
  });

  it('DEFAULT: the per-project index leads — resolves a genuine prompt to its note', async () => {
    const notesDb = { getNotes: () => [
      { node_id: 'ui_ux/filter', note_text: 'filter log entries by status; case-insensitive title match; half-open bounds' },
      { node_id: 'logic/compliance', note_text: 'finalize orphaned sessions as lapsed at session start; backstop surfaced notes' },
    ] };
    const node = await resolveFeatureNodeId(notesDb, 'add a status filter to the entry list',
      { sphere_read_resolver_enabled: false }, undefined);
    expect(node).toBe('ui_ux/filter');
  });

  it('NOISE FIX: a stray keyword no longer false-surfaces (compliance prompt saying "filter")', async () => {
    // The crude keyword map would fire 'ui_ux/filter' here; the index reads the whole
    // prompt and goes to the actually-relevant node instead.
    const notesDb = { getNotes: () => [
      { node_id: 'ui_ux/filter', note_text: 'filter log entries by status; case-insensitive title match; half-open bounds' },
      { node_id: 'logic/compliance', note_text: 'finalize orphaned sessions as lapsed at session start; backstop surfaced notes' },
    ] };
    const node = await resolveFeatureNodeId(notesDb,
      'finalize the orphaned compliance sessions and filter out the stale ones',
      { sphere_read_resolver_enabled: false }, undefined);
    expect(node).not.toBe('ui_ux/filter');
    expect(node).toBe('logic/compliance');
  });

  it('ON + no keyword: falls back to the embedding argmax (hybrid)', async () => {
    const node = await resolveFeatureNodeId(embDb, 'deneme sinavi puanlama ekrani yap',
      { sphere_read_resolver_enabled: true, feature_cluster_threshold: 0.5 }, deps(vec([0.1, 1, 0, 0])));
    expect(node).toBe('security/auth');
  });

  it('ON + no keyword + below threshold: resolves to null (no forced guess)', async () => {
    const node = await resolveFeatureNodeId(embDb, 'deneme sinavi puanlama ekrani yap',
      { sphere_read_resolver_enabled: true, feature_cluster_threshold: 0.99 }, deps(vec([1, 1, 0, 0])));
    expect(node).toBeNull();
  });
});
