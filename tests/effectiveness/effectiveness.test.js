/**
 * ══════════════════════════════════════════════════════════════════════
 * DevGuard Effectiveness Tests — Layer 1: Controlled Scenarios
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## What is DevGuard?
 *
 * A Claude Code plugin that detects loops during vibe coding (repeatedly
 * trying the same failing fix) and prevents overwriting committed bug fixes.
 * Works with 6 hooks (PreToolUse, PostToolUse, SessionStart, PostCompact,
 * UserPromptSubmit, PostCommand).
 *
 * ## Detection Pipeline (pre-edit.js)
 *
 * PreToolUse hook runs before Edit/Write. 6 middlewares in a sequential pipeline:
 *
 *   1. cycle:file_match   (L1) — Same file edited N times in a session
 *   2. cycle:error_hash   (L1) — Same error output (MD5 hash) repeated
 *   3. cycle:diff_match   (L2) — Similar old_strings (Jaccard similarity)
 *   4. cycle:embedding    (L3) — Semantic similarity (MiniLM-L6 cosine, pre-computed)
 *   5. protect:line_resolve    — old_string → line number resolution (helper)
 *   6. protect:check           — Git blame-based protection zone check
 *
 * Decision mechanism:
 *   - matches < min_occurrences (default 2)  → skip (silent)
 *   - matches >= min_occurrences             → warn (context injection, Claude sees it)
 *   - matches >= block_threshold (default 3) → block (exit 2, edit prevented)
 *   - blocking middleware → pipeline stops, subsequent middlewares do not run
 *
 * ## Protection System (protection.js)
 *
 * During post-edit, a temporary protection zone is created for each change.
 * After git commit (post-command) it is promoted (permanent). If protected
 * lines are touched in a different issue context, a warning is issued. In
 * the same issue context, "same-issue exemption" passes silently.
 *
 * ## Known Limitations
 *
 * - L1 file_match counts by filename; editing different functions in the same
 *   file also counts as "N edits" → source of false positives (Scenario E)
 * - L3 embedding requires model download (~22MB) on first session. If model
 *   is absent, L3 silently disables; L1-2 continue working.
 * - Each hook is a new Node.js process. No in-memory state sharing; all state in SQLite.
 *
 * ## Config Defaults
 *
 *   similarity_threshold: 0.85  — L2 Jaccard and L3 cosine threshold
 *   window_size: 10             — Look at last N changes
 *   min_occurrences: 2          — Warning threshold
 *   block_threshold: 3          — Block threshold
 *   periodic_injection_interval: 20 — Automatic status summary every N edits
 *
 * ## What This File Does
 *
 * Measures not whether the code runs, but whether it makes the CORRECT DECISION.
 * 12 controlled scenarios: expected decision (TP/TN/FP/FN) + actual decision.
 * Results written to synthetic-effectiveness-report.json.
 *
 * ## Current Results (2026-04-02)
 *
 *   TP: 6 | TN: 5 | FP: 1 | FN: 0
 *   Precision: 85.7% | Recall: 100% | FP Rate: 16.7%
 *   Single FP: Scenario E (L1 file_match, known limitation)
 *
 * ## Scenario Table
 *
 *   A  — Basic cycle (3x same file+error)                  → TP (block, L1)
 *   B  — Normal workflow (different files)                 → TN (silent)
 *   C  — Semantic similarity (L3, different words)         → TP (block, L3)
 *   D  — Protection zone (different issue, protected line) → TP (warn, protection)
 *   E  — Same file different sections (FP check)           → FP (block, L1) ⚠ known limitation
 *   F  — Error hash cycle (different file, same error)     → TP (block, L1)
 *   G  — Diff similarity (L2, similar code)                → TP (block, L2)
 *   H  — Same-issue exemption                             → TN (silent)
 *   I1 — Below threshold (1 edit)                          → TN (silent)
 *   I2 — Above threshold (2+ edits)                        → TP (warn, L1)
 *   J  — Graceful fail (broken environment)                → TN (exit 0)
 *   K  — Cross-session isolation                           → TN (silent)
 *
 * ## Sprint Status
 *
 * Sprints 0-5 complete (472 tests). This file created at Sprint 5→6 transition.
 * Sprint 6 goal: detection quality (reduce FP, test parse, transcript).
 * FP in Scenario E can be resolved in Sprint 6 with function/section granularity.
 *
 * ## How to Run
 *
 *   npx vitest run tests/effectiveness/effectiveness.test.js
 *
 * Report output: tests/effectiveness/synthetic-effectiveness-report.json
 *
 * Isolation: temp directory, subprocess hook call, does not touch project code.
 * ══════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOKS_DIR = path.resolve(__dirname, '../../src/hooks');
const REPORT_PATH = path.resolve(__dirname, 'synthetic-effectiveness-report.json');

// ─── Report Collection ──────────────────────────────────────────────────
const report = {
  meta: {
    product: 'DevGuard — Claude Code plugin for cycle detection & cross-concern protection',
    test_type: 'SYNTHETIC controlled-scenario test (NOT real-world effectiveness)',
    honesty_note: 'Measures 12 hand-crafted scenarios only. NOT a measurement of real-world precision/recall. For real-world effectiveness see dogfood-effectiveness-report.json (manually classified subset of detection_log). As of 2026-05-17 dogfood report does not yet exist — 822 detections collected, 0 classified.',
    what_this_measures: 'Whether the pipeline makes the CORRECT DECISION on 12 designed-to-be-detectable inputs. Says nothing about real-world utility.',
    pipeline: 'pre-edit.js 6-middleware pipeline: L1 file_match -> L1 error_hash -> L2 diff_match -> L3 embedding -> protect:line_resolve -> protect:check',
    detection_levels: {
      L1_file_match: 'Same file edited N times in session (filename-based)',
      L1_error_hash: 'Same error output (MD5 hash) repeated',
      L2_diff_match: 'Similar old_strings (Jaccard similarity >= 0.85)',
      L3_embedding: 'Semantic similarity (MiniLM-L6 cosine similarity, pre-computed vectors)',
      protection: 'Git blame-based protection — warns if protected line touched in different issue',
    },
    decisions: {
      skip: 'Below threshold, pass silently',
      warn: 'Context injection — Claude sees warning, edit not blocked',
      block: 'exit 2 — edit blocked',
    },
    config_defaults: {
      similarity_threshold: 0.85,
      min_occurrences: 2,
      block_threshold: 3,
      window_size: 10,
    },
    known_limitations: [
      'L1 file_match counts by filename; different sections of the same file produce FP (Scenario E)',
      'L3 embedding silently disables if model absent (eventual consistency)',
      'Each hook is a new Node.js process — no in-memory state, all state in SQLite',
    ],
    sprint_status: 'Sprints 0-5 complete (472 tests). This report generated at Sprint 5->6 transition.',
    sprint_6_goal: 'Detection quality: reduce FP, test parse, transcript, label rotation',
    how_to_run: 'npx vitest run tests/effectiveness/effectiveness.test.js',
  },
  generated_at: new Date().toISOString(),
  scenarios: [],
  summary: { total: 0, tp: 0, tn: 0, fp: 0, fn: 0, precision: 0, recall: 0, fp_rate: 0 },
};

function record(scenario) {
  report.scenarios.push(scenario);
}

function computeSummary() {
  const s = report.summary;
  s.total = report.scenarios.length;
  s.tp = report.scenarios.filter(r => r.classification === 'TP').length;
  s.tn = report.scenarios.filter(r => r.classification === 'TN').length;
  s.fp = report.scenarios.filter(r => r.classification === 'FP').length;
  s.fn = report.scenarios.filter(r => r.classification === 'FN').length;
  s.precision = (s.tp + s.fp) > 0 ? +(s.tp / (s.tp + s.fp)).toFixed(4) : 0;
  s.recall = (s.tp + s.fn) > 0 ? +(s.tp / (s.tp + s.fn)).toFixed(4) : 0;
  s.fp_rate = (s.fp + s.tn) > 0 ? +(s.fp / (s.fp + s.tn)).toFixed(4) : 0;
}

afterAll(() => {
  computeSummary();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  // Print summary to console
  const s = report.summary;
  const lines = [
    '',
    '═══════════════════════════════════════════════',
    '  DevGuard Effectiveness Report — Layer 1',
    '═══════════════════════════════════════════════',
    `  Total scenarios : ${s.total}`,
    `  True Positive   : ${s.tp}`,
    `  True Negative   : ${s.tn}`,
    `  False Positive  : ${s.fp}`,
    `  False Negative  : ${s.fn}`,
    `  Precision       : ${(s.precision * 100).toFixed(1)}%`,
    `  Recall          : ${(s.recall * 100).toFixed(1)}%`,
    `  FP Rate         : ${(s.fp_rate * 100).toFixed(1)}%`,
    '═══════════════════════════════════════════════',
    `  Report: ${REPORT_PATH}`,
    '',
  ];
  console.log(lines.join('\n'));
});

// ─── Helper Functions ──────────────────────────────────────────
let tmpDir, repoDir;

function hookPath(name) {
  return path.join(HOOKS_DIR, `${name}.js`);
}

function runHook(name, input, envOverrides = {}) {
  const start = Date.now();
  try {
    const stdout = execFileSync('node', [hookPath(name)], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tmpDir,
        DEVGUARD_DEBUG: '0',
        DEVGUARD_MODEL_DIR: path.join(tmpDir, 'no-model'),
        DEVGUARD_OFFLINE: '1',
        ...envOverrides,
      },
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ok */ }
    return { stdout, stderr: '', exitCode: 0, parsed, durationMs: Date.now() - start };
  } catch (err) {
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch { /* ok */ }
    return {
      stdout: err.stdout || '', stderr: err.stderr || '',
      exitCode: err.status, parsed, durationMs: Date.now() - start,
    };
  }
}

function createGitRepo() {
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
}

function commitFile(name, content, msg) {
  fs.writeFileSync(path.join(repoDir, name), content, 'utf-8');
  execSync(`git add "${name}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoDir, stdio: 'pipe' });
  return execSync('git log -1 --format=%H', { cwd: repoDir, encoding: 'utf-8' }).trim();
}

function clearModules() {
  const modules = [
    '../../src/engine/db', '../../src/engine/sanitize', '../../src/engine/debug-log',
    '../../src/engine/config', '../../src/engine/cycle-detector',
    '../../src/engine/line-resolver', '../../src/engine/protection',
    '../../src/engine/blame-cache', '../../src/engine/embedding',
    '../../src/hooks/pre-edit', '../../src/hooks/post-compact',
  ];
  for (const m of modules) {
    try { delete require.cache[require.resolve(m)]; } catch { /* ok */ }
  }
}

function loadDb() {
  clearModules();
  return require('../../src/engine/db');
}

function makeNormalizedBuffer(arr) {
  const f32 = new Float32Array(arr);
  let norm = 0;
  for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < f32.length; i++) f32[i] /= norm;
  return Buffer.from(f32.buffer);
}

/** Is there a detection? (warn or block) */
function hasDetection(result) {
  if (result.exitCode === 2) return true;
  const ctx = result.parsed?.hookSpecificOutput?.additionalContext;
  if (ctx && (ctx.includes('DevGuard') || ctx.includes('edited') || ctx.includes('occurred') || ctx.includes('WARNING'))) return true;
  return false;
}

/** Extract detection type */
function getDetectionType(result) {
  if (result.exitCode === 2) return 'block';
  const ctx = result.parsed?.hookSpecificOutput?.additionalContext;
  if (ctx) return 'warn';
  return 'none';
}

function classify(expected, actual) {
  if (expected === 'detect' && actual) return 'TP';
  if (expected === 'detect' && !actual) return 'FN';
  if (expected === 'silent' && !actual) return 'TN';
  if (expected === 'silent' && actual) return 'FP';
  return 'UNKNOWN';
}

// ─── Setup / Teardown ──────────────────────────────────────────────
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-eff-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  createGitRepo();
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  clearModules();
  delete process.env.CLAUDE_PLUGIN_DATA;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO A: Basic Cycle (True Positive expected)
// Same file, same error, 3 attempts → should detect
// ═══════════════════════════════════════════════════════════════════
describe('Scenario A — Basic cycle (same file + same error × 3)', () => {
  it('TP: should produce block or warn', () => {
    runHook('session-start', { cwd: repoDir });

    for (let i = 0; i < 3; i++) {
      runHook('post-edit', {
        cwd: repoDir, tool_name: 'Edit',
        tool_input: {
          file_path: path.join(repoDir, 'app.js').replace(/\\/g, '/'),
          old_string: 'const x = broken();',
          new_string: `const x = fix_${i}();`,
        },
      });
      runHook('post-command', {
        cwd: repoDir, tool_input: { command: 'npm test' },
        tool_response: { exitCode: 1, stderr: 'TypeError: broken is not a function', stdout: '' },
      });
    }

    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'app.js').replace(/\\/g, '/'),
        old_string: 'const x = broken();',
        new_string: 'const x = yet_another();',
      },
    });

    const detected = hasDetection(result);
    const cls = classify('detect', detected);

    record({
      id: 'A', name: 'Basic cycle (same file + same error × 3)',
      expected: 'detect', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: extractLevels(result),
    });

    expect(detected).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO B: Normal workflow (True Negative expected)
// Different files, different content → should remain silent
// ═══════════════════════════════════════════════════════════════════
describe('Scenario B — Normal workflow (different files)', () => {
  it('TN: should remain silent', () => {
    runHook('session-start', { cwd: repoDir });

    const files = ['auth.js', 'db.js', 'routes.js'];
    for (let i = 0; i < 3; i++) {
      runHook('post-edit', {
        cwd: repoDir, tool_name: 'Edit',
        tool_input: {
          file_path: path.join(repoDir, files[i]).replace(/\\/g, '/'),
          old_string: `original_code_${i}_unique_xyz`,
          new_string: `updated_code_${i}_unique_abc`,
        },
      });
    }

    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'utils.js').replace(/\\/g, '/'),
        old_string: 'completely_different_content_never_seen',
        new_string: 'brand_new_content',
      },
    });

    const detected = hasDetection(result);
    const cls = classify('silent', detected);

    record({
      id: 'B', name: 'Normal workflow (different files + different content)',
      expected: 'silent', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: extractLevels(result),
    });

    expect(detected).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO C: Semantic similarity (L3) — Different words, same approach
// Test with synthetic embedding (no model loading)
// ═══════════════════════════════════════════════════════════════════
describe('Scenario C — Semantic similarity (L3, different words same approach)', () => {
  it('TP: should produce embedding_match detection', () => {
    const db = loadDb();
    const proxy = db.getDb(repoDir);
    proxy.insertSession('sem-session');

    // 3 semantically similar changes reworking the SAME file (cross-file
    // pairs no longer count since the 2026-06 embedding FP fix)
    const baseVec = [0.5, 0.3, 0.8, 0.1, 0.6, 0.2, 0.9, 0.4];
    const descriptions = [
      'fix timeout by increasing retry interval to 30s',
      'resolve timeout issue with larger retry delay 45s',
      'address timeout problem extending wait period to 60s',
    ];
    const files = ['src/api.js', 'src/api.js', 'src/api.js'];

    for (let i = 0; i < 3; i++) {
      const vec = makeNormalizedBuffer(baseVec.map((v, j) => v + (j % 3 === i ? 0.01 : 0)));
      const cid = proxy.insertChange({
        session_id: 'sem-session', file: files[i], action: 'Edit',
        description: descriptions[i],
        diff_text: `setTimeout(fn, ${15000 + i * 15000})`,
      });
      proxy.updateChangeEmbedding(cid, vec);
    }

    db.closeDb();
    clearModules();

    // Run pipeline in-process (getting session ID in subprocess is difficult)
    const preEdit = require('../../src/hooks/pre-edit');
    const configMod = require('../../src/engine/config');
    const dbMod = require('../../src/engine/db');
    const proxy2 = dbMod.getDb(repoDir);
    const config = configMod.loadConfig(repoDir);
    // S3.4 (Q1): the embedding cycle-DETECTOR is gated OFF by default; this
    // scenario exercises it, so enable it explicitly.
    config.embedding_detector_enabled = true;

    const results = preEdit.runPipeline({
      db: proxy2, filePath: 'src/new-file.js', oldString: 'setTimeout(fn, 90000)',
      sessionId: 'sem-session', config, projectPath: repoDir, lineRanges: null,
    }, preEdit.MIDDLEWARES);

    const embeddingResult = results.find(r => r.type === 'embedding_match');
    const detected = !!embeddingResult;
    const cls = classify('detect', detected);

    record({
      id: 'C', name: 'Semantic similarity (L3) — different words, same approach',
      expected: 'detect', actual_detection: detected,
      detection_type: embeddingResult ? embeddingResult.decision : 'none',
      classification: cls, duration_ms: 0,
      levels_triggered: results.map(r => `L${r.level}:${r.type}`),
      detail: embeddingResult ? embeddingResult.message : 'L3 not triggered',
    });

    dbMod.closeDb();
    expect(detected).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO D: Protection zone — Different issue changing same lines
// ═══════════════════════════════════════════════════════════════════
describe('Scenario D — Protection zone (different issue, protected lines)', () => {
  it('TP: should produce protection warning', () => {
    commitFile('auth.js', 'line1\nline2\nline3\nline4\nline5\n', 'Init auth.js');
    const absFile = path.join(repoDir, 'auth.js').replace(/\\/g, '/');

    const db = loadDb();
    const proxy = db.getDb(repoDir);
    proxy.insertSession('prot-session');
    const issueId = proxy.insertIssue({ title: 'XSS fix in auth handler', status: 'fixed' });
    const changeId = proxy.insertChange({ file: absFile, session_id: 'prot-session' });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: absFile,
      temp_lines_start: 2, temp_lines_end: 4, temp_protection: 1,
      reason: 'XSS sanitization added',
    });
    db.closeDb();
    clearModules();

    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: { file_path: absFile, old_string: 'line3', new_string: 'line3_modified' },
    });

    const ctx = result.parsed?.hookSpecificOutput?.additionalContext || '';
    const detected = ctx.includes('WARNING') || ctx.includes('Protected');
    const cls = classify('detect', detected);

    record({
      id: 'D', name: 'Protection zone — different issue changing protected lines',
      expected: 'detect', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: ['protection'],
      detail: ctx.substring(0, 200),
    });

    expect(detected).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO E: False Positive check — Same file, different sections
// Editing different functions in a large file → should remain silent
// ═══════════════════════════════════════════════════════════════════
describe('Scenario E — Same file, different sections (FP check)', () => {
  it('TN: editing different functions is not a cycle', () => {
    // big-module.js: 4 fonksiyon, aralarında >5 satır boşluk
    const bigModuleContent = [
      '// Authentication',
      'function authenticate(user) { /* auth logic */ }',
      '//', '//', '//', '//', '//', '//', '//', '//',
      '// Validation',
      'function validateInput(data) { return true; }',
      '//', '//', '//', '//', '//', '//', '//', '//',
      '// Response',
      'function formatResponse(result) { return result; }',
      '//', '//', '//', '//', '//', '//', '//', '//',
      '// Error handling',
      'function handleError(err) { console.log(err); }',
    ].join('\n');
    commitFile('big-module.js', bigModuleContent, 'Add big-module.js');

    runHook('session-start', { cwd: repoDir });

    const filePath = path.join(repoDir, 'big-module.js').replace(/\\/g, '/');

    const edits = [
      { old: 'function authenticate(user) { /* auth logic */ }',
        new: 'function authenticate(user) { return jwt.verify(user.token); }' },
      { old: 'function validateInput(data) { return true; }',
        new: 'function validateInput(data) { return schema.validate(data); }' },
      { old: 'function formatResponse(result) { return result; }',
        new: 'function formatResponse(result) { return { data: result, status: 200 }; }' },
    ];

    // Simulate real Edit: update file then call post-edit (so resolveLines finds correct lines)
    let fileContent = fs.readFileSync(path.join(repoDir, 'big-module.js'), 'utf-8');
    for (const edit of edits) {
      fileContent = fileContent.replace(edit.old, edit.new);
      fs.writeFileSync(path.join(repoDir, 'big-module.js'), fileContent, 'utf-8');
      runHook('post-edit', {
        cwd: repoDir, tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: edit.old, new_string: edit.new },
      });
    }

    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: 'function handleError(err) { console.log(err); }',
        new_string: 'function handleError(err) { logger.error(err); throw err; }',
      },
    });

    const detected = hasDetection(result);
    const cls = classify('silent', detected);

    record({
      id: 'E', name: 'Same file different sections — TN (overlap/proximity check)',
      expected: 'silent', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: extractLevels(result),
      note: detected
        ? 'Still detected — overlap check did not work.'
        : 'Sprint 6 fix: different sections (>5 lines) → L1 skip. TN.',
    });

    expect(detected).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO F: Error hash cycle — Different files, same error
// ═══════════════════════════════════════════════════════════════════
describe('Scenario F — Error hash cycle (different files, same error)', () => {
  it('TP: should produce error_hash detection', () => {
    runHook('session-start', { cwd: repoDir });

    // Edit in 3 different files, but always the same error
    const files = ['a.js', 'b.js', 'c.js'];
    for (let i = 0; i < 3; i++) {
      runHook('post-edit', {
        cwd: repoDir, tool_name: 'Edit',
        tool_input: {
          file_path: path.join(repoDir, files[i]).replace(/\\/g, '/'),
          old_string: `unique_old_${i}_xyz`, new_string: `unique_new_${i}_abc`,
        },
      });
      runHook('post-command', {
        cwd: repoDir, tool_input: { command: 'npm test' },
        tool_response: { exitCode: 1, stderr: 'ECONNREFUSED 127.0.0.1:5432', stdout: '' },
      });
    }

    // Edit in new file → no file_match but error_hash exists
    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'd.js').replace(/\\/g, '/'),
        old_string: 'brand_new_unique_content', new_string: 'different',
      },
    });

    const detected = hasDetection(result);
    const cls = classify('detect', detected);

    record({
      id: 'F', name: 'Error hash cycle — different files, same error',
      expected: 'detect', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: extractLevels(result),
    });

    expect(detected).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO G: Diff similarity (L2) — Similar code, small differences
// ═══════════════════════════════════════════════════════════════════
describe('Scenario G — Diff similarity (L2, similar code small differences)', () => {
  it('TP: should produce diff_match detection', () => {
    runHook('session-start', { cwd: repoDir });

    const baseDiff = 'const result = await fetch(url); const data = result.json(); return data.items.filter(x => x.active);';

    // Write nearly identical code to 3 different files (to not trigger file_match)
    for (let i = 0; i < 3; i++) {
      runHook('post-edit', {
        cwd: repoDir, tool_name: 'Edit',
        tool_input: {
          file_path: path.join(repoDir, `module${i}.js`).replace(/\\/g, '/'),
          old_string: baseDiff,
          new_string: `const result = await fetch(url); const data = result.json(); return data.items.filter(x => x.enabled);`,
        },
      });
    }

    // 4. edit: benzer diff
    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'module3.js').replace(/\\/g, '/'),
        old_string: baseDiff,
        new_string: 'const result = await fetch(url); const data = result.json(); return data.items.filter(x => x.valid);',
      },
    });

    const detected = hasDetection(result);
    const cls = classify('detect', detected);

    record({
      id: 'G', name: 'Diff similarity (L2) — similar code, small differences',
      expected: 'detect', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: extractLevels(result),
    });

    expect(detected).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO H: Same-issue exemption — Protection exists but same issue
// ═══════════════════════════════════════════════════════════════════
describe('Scenario H — Same-issue exemption (same issue touching its own fix)', () => {
  it('TN: should not produce warning when same issue touches its own protection', () => {
    commitFile('auth.js', 'line1\nline2\nline3\nline4\nline5\n', 'Init auth.js');
    const absFile = path.join(repoDir, 'auth.js').replace(/\\/g, '/');

    const db = loadDb();
    const proxy = db.getDb(repoDir);
    proxy.insertSession('same-issue-session');
    const issueId = proxy.insertIssue({ title: 'Auth token fix', status: 'open' });
    const changeId = proxy.insertChange({
      file: absFile, session_id: 'same-issue-session', related_issue_id: issueId,
    });
    proxy.insertProtectedZone({
      issue_id: issueId, change_id: changeId, file: absFile,
      temp_lines_start: 2, temp_lines_end: 4, temp_protection: 1,
      reason: 'Token fix iteration',
    });
    db.closeDb();
    clearModules();

    // Same issue still open → pre-edit should run in this issue context → exemption
    const preEdit = require('../../src/hooks/pre-edit');
    const configMod = require('../../src/engine/config');
    const dbMod = require('../../src/engine/db');
    const proxy2 = dbMod.getDb(repoDir);
    const config = configMod.loadConfig(repoDir);

    const results = preEdit.runPipeline({
      db: proxy2, filePath: absFile, oldString: 'line3',
      sessionId: 'same-issue-session', config, projectPath: repoDir,
      lineRanges: [{ start: 3, end: 3 }],
    }, preEdit.MIDDLEWARES);

    const protResult = results.find(r => r.type === 'protection');
    const detected = !!protResult;
    const cls = classify('silent', detected);

    record({
      id: 'H', name: 'Same-issue exemption — same issue touching its own fix',
      expected: 'silent', actual_detection: detected,
      detection_type: detected ? 'warn' : 'none',
      classification: cls, duration_ms: 0,
      levels_triggered: results.map(r => `L${r.level}:${r.type}`),
    });

    dbMod.closeDb();
    expect(detected).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO I: Low repetition — Below threshold (2 edits, min_occurrences=2)
// Exactly at threshold: should warn but not block
// ═══════════════════════════════════════════════════════════════════
describe('Scenario I — Threshold boundary (warn at exact min_occurrences, silent below)', () => {
  it('1 edit → silent, 2 edits → warn (not block)', () => {
    runHook('session-start', { cwd: repoDir });
    const filePath = path.join(repoDir, 'app.js').replace(/\\/g, '/');
    // Reused string forces diff_match to engage (file_match alone is now downgraded).
    const repeated = 'function process(timeout) { return retry(timeout); }';

    // 1 edit — below threshold
    runHook('post-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: repeated, new_string: 'code_b' },
    });

    const result1 = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: repeated, new_string: 'code_d' },
    });

    const detected1 = hasDetection(result1);

    // 2nd edit → min_occurrences (2) now met
    runHook('post-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: repeated, new_string: 'code_f' },
    });

    const result2 = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: repeated, new_string: 'code_h' },
    });

    const detected2 = hasDetection(result2);

    record({
      id: 'I-1', name: 'Below threshold (1 edit) → silent',
      expected: 'silent', actual_detection: detected1,
      detection_type: getDetectionType(result1),
      classification: classify('silent', detected1),
      duration_ms: result1.durationMs,
      levels_triggered: extractLevels(result1),
    });

    record({
      id: 'I-2', name: 'Above threshold (2+ edits) → warn',
      expected: 'detect', actual_detection: detected2,
      detection_type: getDetectionType(result2),
      classification: classify('detect', detected2),
      duration_ms: result2.durationMs,
      levels_triggered: extractLevels(result2),
      note: result2.exitCode === 2 ? 'Block (threshold: block_threshold=3 should not be exceeded)' : 'Warn (correct)',
    });

    expect(detected1).toBe(false);
    expect(detected2).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO J: Graceful fail — No crash in broken environment
// ═══════════════════════════════════════════════════════════════════
describe('Scenario J — Graceful fail (broken environment)', () => {
  it('TN: broken DB/environment → exit 0, no false alarm', () => {
    const badDir = path.join(os.tmpdir(), `devguard-broken-${Date.now()}`);

    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'test.js').replace(/\\/g, '/'),
        old_string: 'x', new_string: 'y',
      },
    }, { CLAUDE_PLUGIN_DATA: badDir });

    const detected = hasDetection(result);
    const cls = classify('silent', detected);

    record({
      id: 'J', name: 'Graceful fail — broken environment',
      expected: 'silent', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: [],
      note: `exit code: ${result.exitCode}`,
    });

    expect(result.exitCode).toBe(0);
    expect(detected).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SCENARIO K: Cross-session isolation
// Loop in previous session should not affect new session
// ═══════════════════════════════════════════════════════════════════
describe('Scenario K — Cross-session isolation', () => {
  it('TN: old session cycle should not affect new session', () => {
    const db = loadDb();
    const proxy = db.getDb(repoDir);

    // Old session: 5 edits to same file (cycle)
    proxy.insertSession('old-session');
    for (let i = 0; i < 5; i++) {
      proxy.insertChange({ file: 'app.js', session_id: 'old-session', diff_text: `attempt_${i}` });
      proxy.insertErrorOutput({ error_string: 'same error', error_hash: 'hash-x', session_id: 'old-session' });
    }

    // New session: clean
    proxy.insertSession('new-session');
    db.closeDb();
    clearModules();

    // pre-edit in new session → should be clean
    const result = runHook('pre-edit', {
      cwd: repoDir, tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repoDir, 'app.js').replace(/\\/g, '/'),
        old_string: 'first_edit_new_session', new_string: 'updated',
      },
    });

    const detected = hasDetection(result);
    const cls = classify('silent', detected);

    record({
      id: 'K', name: 'Cross-session isolation — old cycle does not affect new session',
      expected: 'silent', actual_detection: detected,
      detection_type: getDetectionType(result),
      classification: cls, duration_ms: result.durationMs,
      levels_triggered: extractLevels(result),
    });

    expect(detected).toBe(false);
  });
});


// ─── Helper: Extract detected levels ──────────────────
function extractLevels(result) {
  const levels = [];
  const ctx = result.parsed?.hookSpecificOutput?.additionalContext || '';
  const stderr = result.stderr || '';
  const combined = ctx + stderr;
  if (combined.includes('edited') || combined.includes('file_match')) levels.push('L1:file_match');
  if (combined.includes('occurred') || combined.includes('error_hash')) levels.push('L1:error_hash');
  if (combined.includes('similar edit') || combined.includes('diff_match')) levels.push('L2:diff_match');
  if (combined.includes('Semantic') || combined.includes('embedding')) levels.push('L3:embedding');
  if (combined.includes('WARNING') || combined.includes('Protected')) levels.push('protection');
  return levels;
}
