import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/pre-edit.js');

let tmpDir;
let projectDir;

function loadModules() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/config')];
  delete require.cache[require.resolve('../../src/engine/cycle-detector')];
  delete require.cache[require.resolve('../../src/engine/line-resolver')];
  delete require.cache[require.resolve('../../src/engine/protection')];
  delete require.cache[require.resolve('../../src/engine/blame-cache')];
  delete require.cache[require.resolve('../../src/hooks/pre-edit')];
  return {
    db: require('../../src/engine/db'),
    preEdit: require('../../src/hooks/pre-edit'),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-preedit-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-project-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete require.cache[require.resolve('../../src/engine/config')];
  delete require.cache[require.resolve('../../src/engine/cycle-detector')];
  delete require.cache[require.resolve('../../src/engine/line-resolver')];
  delete require.cache[require.resolve('../../src/engine/protection')];
  delete require.cache[require.resolve('../../src/engine/blame-cache')];
  delete require.cache[require.resolve('../../src/hooks/pre-edit')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const dir of [tmpDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

describe('pre-edit.js — runPipeline', () => {
  it('returns empty array for empty middleware list', () => {
    const { preEdit } = loadModules();
    const results = preEdit.runPipeline({}, []);
    expect(results).toEqual([]);
  });

  it('collects warn results with middlewareId', () => {
    const { preEdit } = loadModules();
    const mw = { id: 'test:warn', fn: () => ({ decision: 'warn', level: 1, confidence: 0.5, matches: [], message: 'test' }) };
    const results = preEdit.runPipeline({}, [mw]);
    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe('warn');
    expect(results[0].middlewareId).toBe('test:warn');
  });

  it('skips middleware that returns skip', () => {
    const { preEdit } = loadModules();
    const skip = { id: 'test:skip', fn: () => ({ decision: 'skip', level: 0, confidence: 0, matches: [], message: '' }) };
    const warn = { id: 'test:warn', fn: () => ({ decision: 'warn', level: 1, confidence: 0.5, matches: [], message: 'hit' }) };
    const results = preEdit.runPipeline({}, [skip, warn]);
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe('hit');
  });

  it('does not stop on block (all middlewares run for multi-level promotion)', () => {
    const { preEdit } = loadModules();
    const blockMw = { id: 'test:block', fn: () => ({ decision: 'warn', level: 1, confidence: 1, matches: [], message: 'warned' }) };
    const afterBlock = { id: 'test:after', fn: () => ({ decision: 'warn', level: 2, confidence: 0.5, matches: [], message: 'also runs' }) };
    const results = preEdit.runPipeline({}, [blockMw, afterBlock]);
    expect(results).toHaveLength(2);
    expect(results[0].decision).toBe('warn');
    expect(results[1].decision).toBe('warn');
  });

  it('skips middleware that throws (non-blocking fail)', () => {
    const { preEdit } = loadModules();
    const failing = { id: 'test:fail', fn: () => { throw new Error('middleware crash'); } };
    const warn = { id: 'test:warn', fn: () => ({ decision: 'warn', level: 1, confidence: 0.5, matches: [], message: 'ok' }) };
    const results = preEdit.runPipeline({}, [failing, warn]);
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe('ok');
  });
});

describe('pre-edit.js — formatMessage', () => {
  it('formats warn message with DG-tag CTA', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 1, confidence: 0.5, matches: [], message: 'Dosya 2 kez duzenlendi.' },
    ];
    const msg = preEdit.formatMessage(results, 'warn');
    expect(msg).toContain("I'm DevGuard");
    expect(msg).toContain('Dosya 2 kez duzenlendi.');
    expect(msg).toContain('REQUIRED: Start your next reply');
    expect(msg).toContain('[DG-CONTINUE]');
    expect(msg).toContain('[DG-PIVOT]');
    expect(msg).toContain('[DG-PAUSE]');
  });

  it('formats multi-level warn with DG-tag CTA', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 1, matches: [], message: 'Ayni hata 3 kez.' },
      { decision: 'warn', level: 2, type: 'diff_match', confidence: 0.9, matches: [], message: 'Benzer duzenleme.' },
    ];
    const msg = preEdit.formatMessage(results, 'warn');
    expect(msg).toContain("I'm DevGuard");
    expect(msg).toContain('[DG-CONTINUE]');
  });
});

describe('pre-edit.js — formatMessage shared directive block (S3.1)', () => {
  it('routes the CTA through the shared buildDirectiveBlock — single header, no drift', () => {
    const { preEdit } = loadModules();
    const { buildDirectiveBlock } = require('../../src/engine/message-builder');
    const results = [
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 0.5, matches: [], message: 'x' },
    ];
    const msg = preEdit.formatMessage(results, 'warn');
    expect((msg.match(/REQUIRED: Start your next reply/g) || []).length).toBe(1);
    for (const line of buildDirectiveBlock(false)) {
      expect(msg).toContain(line.trim());
    }
  });

  it('includes preserve-fix clause for protection via shared builder', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 0, type: 'protection', confidence: 1.0, matches: [], message: 'p' },
    ];
    const msg = preEdit.formatMessage(results);
    expect(msg).toContain('preserve the existing fix');
  });
});

describe('pre-edit.js — pickCognitiveLabel', () => {
  it('returns independence when diffMatch + errorHash present', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 2, type: 'diff_match', confidence: 0.9, matches: [], message: 'Benzer duzenleme' },
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 0.5, matches: [], message: 'Ayni hata' },
    ];
    expect(preEdit.pickCognitiveLabel(results)).toContain('Small variations');
  });

  it('returns anchoring when errorHash + multiple signals', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 0.8, matches: [], message: 'Ayni hata 3 kez' },
      { decision: 'warn', level: 1, type: 'file_match', confidence: 0.6, matches: [], message: 'Dosya duzenlendi' },
    ];
    expect(preEdit.pickCognitiveLabel(results)).toContain('anchored to your initial');
  });

  it('returns sunk_cost when diffMatch + multiple signals (after others used)', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 2, type: 'diff_match', confidence: 0.7, matches: [], message: 'Benzer' },
      { decision: 'warn', level: 1, type: 'test_repeat', confidence: 0.8, matches: [], message: 'test' },
    ];
    // preferred order: sunk_cost (diff+multi), framing_effect (multi) — first picked is sunk_cost
    expect(preEdit.pickCognitiveLabel(results)).toContain('Previous attempts would have worked');
  });

  it('returns framing_effect when sunk_cost is recently used', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 2, type: 'diff_match', confidence: 0.7, matches: [], message: 'diff' },
      { decision: 'warn', level: 1, type: 'test_repeat', confidence: 0.8, matches: [], message: 'test' },
    ];
    // sunk_cost would be first, but mark it used so framing_effect surfaces
    const label = preEdit.pickCognitiveLabel(results, ['Previous attempts would have worked if they were correct.']);
    expect(label).toContain('Question the assumption');
  });

  it('returns null when only one non-file signal with no special pairing', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 0.4, matches: [], message: 'tek hata' },
    ];
    expect(preEdit.pickCognitiveLabel(results)).toBeNull();
  });
});

describe('pre-edit.js — formatMessage with cognitive labels', () => {
  it('includes cognitive label in warn message with diffMatch + errorHash', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 2, type: 'diff_match', confidence: 0.9, matches: [], message: 'Benzer duzenleme' },
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 0.5, matches: [], message: 'Ayni hata' },
    ];
    const msg = preEdit.formatMessage(results, 'warn');
    expect(msg).toContain('Small variations');
    expect(msg).toContain("I'm DevGuard");
  });

  it('includes anchoring label in block message with errorHash + diffMatch', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 1, type: 'error_hash', confidence: 1, matches: [], message: 'Ayni hata 3 kez' },
      { decision: 'warn', level: 2, type: 'diff_match', confidence: 0.6, matches: [], message: 'Benzer' },
    ];
    const msg = preEdit.formatMessage(results, 'block');
    // errorHash + multipleSignals → anchoring (also independence due to diff+errorHash)
    expect(msg).toMatch(/anchored to your initial|Small variations/);
    expect(msg).toContain("I'm DevGuard");
  });
});

describe('pre-edit.js — pipeline ordering', () => {
  it('all middlewares run (no early exit) for multi-level promotion', () => {
    const { preEdit } = loadModules();
    const warnMw = { id: 'cycle:file_match', fn: () => ({ decision: 'warn', level: 1, type: 'file_match', confidence: 0.5, matches: [], message: 'warn' }) };
    const warnMw2 = { id: 'cycle:error_hash', fn: () => ({ decision: 'warn', level: 1, type: 'error_hash', confidence: 1, matches: [], message: 'warn2' }) };
    const warnMw3 = { id: 'cycle:diff_match', fn: () => ({ decision: 'warn', level: 2, type: 'diff_match', confidence: 0.5, matches: [], message: 'warn3' }) };
    const results = preEdit.runPipeline({}, [warnMw, warnMw2, warnMw3]);
    expect(results).toHaveLength(3);
    expect(results[0].decision).toBe('warn');
    expect(results[1].decision).toBe('warn');
    expect(results[2].decision).toBe('warn');
  });

  it('all skip → empty results', () => {
    const { preEdit } = loadModules();
    const skip1 = { id: 'test:skip1', fn: () => ({ decision: 'skip', level: 0, type: null, confidence: 0, matches: [], message: '' }) };
    const skip2 = { id: 'test:skip2', fn: () => ({ decision: 'skip', level: 0, type: null, confidence: 0, matches: [], message: '' }) };
    const results = preEdit.runPipeline({}, [skip1, skip2]);
    expect(results).toHaveLength(0);
  });
});

describe('pre-edit.js — MIDDLEWARES structure', () => {
  it('has 5 middlewares with correct IDs (file_match removed in v0.2.2)', () => {
    const { preEdit } = loadModules();
    expect(preEdit.MIDDLEWARES).toHaveLength(5);
    expect(preEdit.MIDDLEWARES[0].id).toBe('cycle:error_hash');
    expect(preEdit.MIDDLEWARES[1].id).toBe('cycle:diff_match');
    expect(preEdit.MIDDLEWARES[2].id).toBe('cycle:test_repeat');
    expect(preEdit.MIDDLEWARES[3].id).toBe('cycle:embedding');
    expect(preEdit.MIDDLEWARES[4].id).toBe('protect:check');
  });

  it('all middlewares have fn property as function', () => {
    const { preEdit } = loadModules();
    for (const mw of preEdit.MIDDLEWARES) {
      expect(typeof mw.fn).toBe('function');
    }
  });
});

describe('pre-edit.js — protection message format', () => {
  it('formats protection warning with DG-tag CTA + preserve-fix note', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 0, type: 'protection', confidence: 1.0, matches: [], message: 'DIKKAT: Bu satirlar fix icin eklendi.' },
    ];
    const msg = preEdit.formatMessage(results);
    expect(msg).toContain("I'm DevGuard");
    expect(msg).toContain('[DG-CONTINUE]');
    expect(msg).toContain('preserve the existing fix');
  });
});

describe('pre-edit.js — hook execution', () => {
  function runPreEdit(inputObj) {
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

  function seedDb() {
    const db = loadModules().db;
    return db.getDb(projectDir);
  }

  it('allows when no previous edits (exit 0, no additionalContext)', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/app.js', old_string: 'x', new_string: 'y' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('warns (L1 only) after 2 edits to same file + 2 same errors', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    proxy.insertChange({ file: '/project/app.js', session_id: 'sess-1', diff_text: 'completely_different_text_1' });
    proxy.insertChange({ file: '/project/app.js', session_id: 'sess-1', diff_text: 'completely_different_text_2' });
    proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'abc123', session_id: 'sess-1' });
    proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'abc123', session_id: 'sess-1' });
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/app.js', old_string: 'unique_new_content', new_string: 'new code' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard');
  });

  it('warns after 3 edits + 3 errors (never blocks)', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: '/project/app.js', session_id: 'sess-1', diff_text: 'broken code' });
      proxy.insertErrorOutput({ error_string: 'fail', error_hash: 'abc123', session_id: 'sess-1' });
    }
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/app.js', old_string: 'broken code', new_string: 'try fix' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard');
    // Yol 4: only LLM-generated (llm_used) notes are surfaced. With the model
    // disabled in tests the deterministic fallback is intentionally NOT
    // surfaced (it would just restate the diff_match section already shown).
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Pattern analysis:');
  });

  it('silent when only same file edited with no semantic similarity (post v0.2.2)', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    const normalizedFile = path.resolve(path.join(projectDir, 'app.js')).replace(/\\/g, '/');
    proxy.insertChange({ file: normalizedFile, session_id: 'sess-1', diff_text: 'unique_alpha_content' });
    proxy.insertChange({ file: normalizedFile, session_id: 'sess-1', diff_text: 'unique_beta_content' });
    proxy.insertChange({ file: normalizedFile, session_id: 'sess-1', diff_text: 'unique_gamma_content' });
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'app.js'), old_string: 'unique_delta_content', new_string: 'new' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('warns when L1 + L2 multi-level (always warn, never block)', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    const normalizedFile = path.resolve(path.join(projectDir, 'app.js')).replace(/\\/g, '/');
    for (let i = 0; i < 3; i++) {
      proxy.insertChange({ file: normalizedFile, session_id: 'sess-1', diff_text: 'repeated broken code' });
    }
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'app.js'), old_string: 'repeated broken code', new_string: 'fix' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard');
  });

  it('writes to detection_log on warn (via diff_match)', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    const normalizedFile = path.resolve(path.join(projectDir, 'app.js')).replace(/\\/g, '/');
    const repeat = 'function process(timeout) { return retry(timeout); }';
    proxy.insertChange({ file: normalizedFile, session_id: 'sess-1', diff_text: repeat });
    proxy.insertChange({ file: normalizedFile, session_id: 'sess-1', diff_text: repeat });
    loadModules().db.closeDb();

    runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'app.js'), old_string: repeat, new_string: 'ddd' },
    });

    const { db } = loadModules();
    const dbProxy = db.getDb(projectDir);
    const detections = dbProxy.getDetections({ session_id: 'sess-1' });
    db.closeDb();
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].decision).toBe('warn');
  });

  // NOTE: "file history" rich section now never appears, because solo file_match is
  // dropped from user-facing message (downgrade). In a combo, the peer signal (diff/error/embedding)
  // owns the message. Re-introducing file history in combos is a separate task.

  it('rich message: error_hash shows "Tekrarlayan Hata" with error preview', () => {
    const proxy = seedDb();
    proxy.insertSession('sess-1');
    proxy.insertChange({ file: '/project/app.js', session_id: 'sess-1', diff_text: 'x1' });
    proxy.insertChange({ file: '/project/app.js', session_id: 'sess-1', diff_text: 'x2' });
    proxy.insertErrorOutput({ error_string: 'ECONNREFUSED 127.0.0.1:5432', error_hash: 'abc123', session_id: 'sess-1' });
    proxy.insertErrorOutput({ error_string: 'ECONNREFUSED 127.0.0.1:5432', error_hash: 'abc123', session_id: 'sess-1' });
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/app.js', old_string: 'unique_abc_content', new_string: 'new' },
    });
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext;
    expect(ctx).toBeDefined();
    expect(ctx).toContain('Recurring error');
    expect(ctx).toContain('ECONNREFUSED');
    expect(ctx).not.toMatch(/\d+ kez tekrarlandi/);
  });

  it('intervention_enabled=false: suppresses context injection but STILL records detection (passive A/B)', () => {
    fs.writeFileSync(
      path.join(projectDir, 'devguard.config.yaml'),
      'intervention_enabled: false\n',
    );
    const appFile = path.join(projectDir, 'app.js').replace(/\\/g, '/');
    const proxy = seedDb();
    proxy.insertSession('passive-sess');
    const repeat = 'function process(timeout) { return retry(timeout); }';
    proxy.insertChange({ file: appFile, session_id: 'passive-sess', diff_text: repeat });
    proxy.insertChange({ file: appFile, session_id: 'passive-sess', diff_text: repeat });
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: appFile, old_string: repeat, new_string: 'ddd' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    // Passive: ZERO injection reaches Claude
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();

    // Measurement preserved: detection_log still got the warn row
    const { db } = loadModules();
    const dbProxy = db.getDb(projectDir);
    const detections = dbProxy.getDetections({ session_id: 'passive-sess' });
    db.closeDb();
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].decision).toBe('warn');
  });

  it('intervention_enabled=true (explicit): injects the warning as before', () => {
    fs.writeFileSync(
      path.join(projectDir, 'devguard.config.yaml'),
      'intervention_enabled: true\n',
    );
    const appFile = path.join(projectDir, 'app.js').replace(/\\/g, '/');
    const proxy = seedDb();
    proxy.insertSession('active-sess');
    const repeat = 'function process(timeout) { return retry(timeout); }';
    proxy.insertChange({ file: appFile, session_id: 'active-sess', diff_text: repeat });
    proxy.insertChange({ file: appFile, session_id: 'active-sess', diff_text: repeat });
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: appFile, old_string: repeat, new_string: 'ddd' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('DevGuard');
  });

  it('intervention_enabled=false: suppresses pending-summary injection too', () => {
    fs.writeFileSync(
      path.join(projectDir, 'devguard.config.yaml'),
      'intervention_enabled: false\n',
    );
    const proxy = seedDb();
    proxy.insertSession('passive-pending');
    proxy.setPendingSummary('passive-pending', 'DevGuard Session Summary:\n- pending');
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'app.js').replace(/\\/g, '/'), old_string: 'x', new_string: 'y' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('allows when no file_path in input', () => {
    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {},
    });
    expect(result.exitCode).toBe(0);
  });

  it('allows (graceful fail) when no session exists', () => {
    // No session created — DB exists but empty
    const db = loadModules().db;
    db.openDb(); // ensure DB file exists
    db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/app.js', old_string: 'x', new_string: 'y' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('graceful fail on invalid input', () => {
    const result = runPreEdit('not json');
    expect(result.exitCode).toBe(0);
  });

  it('path exclusion: returns allow immediately for .claude/ path without touching DB', () => {
    // Do NOT seed a session — hook should exit before DB access
    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(projectDir, '.claude', 'settings.json').replace(/\\/g, '/'),
        old_string: 'a',
        new_string: 'b',
      },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    // No hookSpecificOutput means plain allow, no context injection
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('path exclusion: MEMORY.md basename excluded even with cycle history present', () => {
    const proxy = seedDb();
    proxy.insertSession('mem-sess');
    // Pre-seed 5 changes on MEMORY.md — would normally trigger file_match
    for (let i = 0; i < 5; i++) {
      proxy.insertChange({ file: '/project/MEMORY.md', session_id: 'mem-sess' });
    }
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/project/MEMORY.md', old_string: 'a', new_string: 'b' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('cooldown: second warn within 3 edits is suppressed for same (file, middleware)', () => {
    // Use a real absolute path so normalizePath inside the hook matches our stored path
    const appFile = path.join(projectDir, 'app.js').replace(/\\/g, '/');
    const proxy = seedDb();
    proxy.insertSession('cd-sess');
    // Seed diff_match combo (repeating diff) — file_match alone would be dropped post-downgrade
    const repeat = 'function foo() { return retry(timeout); }';
    proxy.insertChange({ file: appFile, session_id: 'cd-sess', diff_text: repeat });
    proxy.insertChange({ file: appFile, session_id: 'cd-sess', diff_text: repeat });
    loadModules().db.closeDb();

    // First call — diff_match should fire (boosted by file_match)
    const first = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: appFile, old_string: repeat, new_string: 'y1' },
    });
    expect(first.exitCode).toBe(0);
    const firstOut = JSON.parse(first.stdout);
    expect(firstOut.hookSpecificOutput?.additionalContext).toBeDefined();

    // Simulate post-edit writing a change after the first call
    const proxy2 = seedDb();
    proxy2.insertChange({ file: appFile, session_id: 'cd-sess', diff_text: repeat });
    loadModules().db.closeDb();

    // Second call — same file, same session, only 1 change since last detection
    // Cooldown (N=3) should suppress
    const second = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: appFile, old_string: repeat, new_string: 'y2' },
    });
    expect(second.exitCode).toBe(0);
    const secondOut = JSON.parse(second.stdout);
    // Suppressed — no context injection
    expect(secondOut.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('cooldown: detection_cooldown_edits=0 disables suppression', () => {
    // Write a config yaml disabling cooldown
    fs.writeFileSync(
      path.join(projectDir, 'devguard.config.yaml'),
      'detection_cooldown_edits: 0\n',
    );

    const appFile = path.join(projectDir, 'app.js').replace(/\\/g, '/');
    const proxy = seedDb();
    proxy.insertSession('cd0-sess');
    const repeat = 'function bar() { return retry(timeout); }';
    proxy.insertChange({ file: appFile, session_id: 'cd0-sess', diff_text: repeat });
    proxy.insertChange({ file: appFile, session_id: 'cd0-sess', diff_text: repeat });
    // Pre-existing detection — would normally be suppressed with cooldown on
    proxy.insertDetection({
      session_id: 'cd0-sess', file: appFile, middleware_id: 'cycle:diff_match',
      decision: 'warn', level: 2, type: 'diff_match', confidence: 1, message: 'x',
    });
    loadModules().db.closeDb();

    const result = runPreEdit({
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: appFile, old_string: repeat, new_string: 'y' },
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    // Cooldown off → warn fires despite prior detection
    expect(output.hookSpecificOutput?.additionalContext).toBeDefined();
  });
});

describe('pre-edit.js — embeddingMiddleware', () => {
  function makeNormalizedBuffer(arr) {
    const f32 = new Float32Array(arr);
    let norm = 0;
    for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
    return Buffer.from(f32.buffer);
  }

  function makeCtx(db, overrides = {}) {
    return {
      db,
      filePath: '/project/app.js',
      oldString: 'const x = 1;',
      sessionId: 'test-session',
      config: { similarity_threshold: 0.85, embedding_similarity_threshold: 0.85, window_size: 10, min_occurrences: 2, block_threshold: 3, embedding_enabled: true, embedding_detector_enabled: true },
      projectPath: projectDir,
      lineRanges: null,
      ...overrides,
    };
  }

  it('returns skip when no embeddings in DB', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');
    const ctx = makeCtx(db);
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('skip');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('returns skip with only 1 embedding', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');
    const emb = makeNormalizedBuffer([1, 2, 3, 4]);
    const changeId = db.insertChange({ session_id: 'test-session', file: 'a.js', action: 'Edit' });
    db.updateChangeEmbedding(changeId, emb);
    const ctx = makeCtx(db);
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('skip');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('warns when >= min_occurrences similar pairs found in the same file', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const similar = makeNormalizedBuffer([1, 2, 3, 4]);
    for (let i = 0; i < 3; i++) {
      const cid = db.insertChange({ session_id: 'test-session', file: 'app.js', action: 'Edit' });
      db.updateChangeEmbedding(cid, similar);
    }

    const ctx = makeCtx(db);
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('warn');
    expect(result.type).toBe('embedding_match');
    expect(result.level).toBe(3);
    expect(result.message).toContain('Semantic similarity');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('skips when similar embeddings span different files (feature work, not a cycle)', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const similar = makeNormalizedBuffer([1, 2, 3, 4]);
    for (let i = 0; i < 4; i++) {
      const cid = db.insertChange({ session_id: 'test-session', file: `f${i}.js`, action: 'Edit' });
      db.updateChangeEmbedding(cid, similar);
    }

    const ctx = makeCtx(db);
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('skip');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('skips same-file pairs below embedding_similarity_threshold', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    // cosine([1,0], [0.75, 0.661]) ≈ 0.75 — below the 0.85 embedding threshold
    const vectors = [
      makeNormalizedBuffer([1, 0]),
      makeNormalizedBuffer([0.75, 0.6614]),
      makeNormalizedBuffer([1, 0]),
    ];
    for (const v of vectors) {
      const cid = db.insertChange({ session_id: 'test-session', file: 'app.js', action: 'Edit' });
      db.updateChangeEmbedding(cid, v);
    }

    // similarity_threshold deliberately low: if the middleware wrongly used it,
    // all 3 pairs would pass and this would warn
    const ctx = makeCtx(db, { config: { ...makeCtx(db).config, similarity_threshold: 0.70, min_occurrences: 3 } });
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('skip');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('falls back to similarity_threshold when embedding_similarity_threshold missing', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const similar = makeNormalizedBuffer([1, 2, 3, 4]);
    for (let i = 0; i < 3; i++) {
      const cid = db.insertChange({ session_id: 'test-session', file: 'app.js', action: 'Edit' });
      db.updateChangeEmbedding(cid, similar);
    }

    const config = { ...makeCtx(db).config };
    delete config.embedding_similarity_threshold;
    const ctx = makeCtx(db, { config });
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('warn');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('skips when embedding_enabled is false', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const similar = makeNormalizedBuffer([1, 2, 3, 4]);
    for (let i = 0; i < 3; i++) {
      const cid = db.insertChange({ session_id: 'test-session', file: `f${i}.js`, action: 'Edit' });
      db.updateChangeEmbedding(cid, similar);
    }

    const ctx = makeCtx(db, { config: { ...makeCtx(db).config, embedding_enabled: false } });
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('skip');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('skips when all embeddings are dissimilar', () => {
    const { preEdit, db: dbMod } = loadModules();
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    const db = dbMod.getDb(projectDir);
    db.insertSession('test-session');

    const vectors = [
      makeNormalizedBuffer([1, 0, 0, 0]),
      makeNormalizedBuffer([0, 1, 0, 0]),
      makeNormalizedBuffer([0, 0, 1, 0]),
    ];
    for (let i = 0; i < vectors.length; i++) {
      const cid = db.insertChange({ session_id: 'test-session', file: `f${i}.js`, action: 'Edit' });
      db.updateChangeEmbedding(cid, vectors[i]);
    }

    const ctx = makeCtx(db);
    const result = preEdit.embeddingMiddleware(ctx);
    expect(result.decision).toBe('skip');
    dbMod.closeDb();
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('pickCognitiveLabel returns independence for embedding_match', () => {
    const { preEdit } = loadModules();
    const results = [
      { decision: 'warn', level: 3, type: 'embedding_match', confidence: 0.9, matches: [], message: 'test' },
    ];
    const label = preEdit.pickCognitiveLabel(results);
    expect(label).toContain('Small variations');
  });
});
