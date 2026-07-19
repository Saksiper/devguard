'use strict';

// DevGuard A/B effectiveness harness — orchestrator.
// Runs each task in two isolated `claude -p` sandboxes (passive vs active),
// judges the outputs blind + swapped, collects proxies, writes a JSON report.
// Isolation strategy B: unique project_path per run (DevGuard multi-tenant key);
// production DB is written then cleaned up per pair. Run serially (concurrency=1)
// so concurrent runs never contend on the production DB.
//
// Usage:
//   node tools/dg-ab-harness.js
// Env overrides: DG_AB_MODEL, DG_AB_JUDGE_MODEL, DG_AB_REPLICAS, DG_AB_ONLY
//   (comma task ids), DG_AB_TASKS, DG_AB_REPORT, DG_AB_DB.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { stripMarkers } = require('./lib/ab-strip');
const runner = require('./dg-ab-runner');
const judge = require('./dg-ab-judge');

const REPO_ROOT = path.resolve(__dirname, '..');

function getProdDbPath() {
  if (process.env.DG_AB_DB) return process.env.DG_AB_DB;
  try { return require('../src/engine/db').getDbPath(); } catch { return null; }
}

// Open a DB handle with a busy_timeout so concurrent harness processes (parallel
// group runs, or a live hook) that briefly contend on the shared production DB
// wait-and-retry instead of throwing SQLITE_BUSY. Connection-scoped: does NOT
// change the DB's persistent journal mode.
function openDb(dbPath, opts) {
  const db = new Database(dbPath, opts);
  try { db.pragma('busy_timeout = 8000'); } catch { /* ignore */ }
  return db;
}

function parseArgs() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    tasksFile: process.env.DG_AB_TASKS || path.join(REPO_ROOT, 'tests', 'ab-harness', 'tasks.json'),
    fixturesRoot: path.join(REPO_ROOT, 'tests', 'ab-harness'),
    replicas: parseInt(process.env.DG_AB_REPLICAS || process.argv[2] || '1', 10),
    only: (process.env.DG_AB_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean),
    model: process.env.DG_AB_MODEL || 'opus',
    judgeModel: process.env.DG_AB_JUDGE_MODEL || 'opus',
    outReport: process.env.DG_AB_REPORT || path.join(REPO_ROOT, 'tests', 'ab-harness', 'ab-effectiveness-report.json'),
    dbPath: getProdDbPath(),
    base: process.env.DG_AB_BASE || path.join(os.tmpdir(), 'dg-ab-runs', ts),
  };
}

// Synchronous sleep so the async PostToolUse hook can finish writing to the DB
// before we read proxies (spawnSync already returned, but the async hook may lag).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function collectProxies(dbPath, projectPath) {
  if (!dbPath) return {};
  let db;
  try { db = openDb(dbPath, { readonly: true }); return runner.collectProxiesFromDb(db, projectPath); }
  catch { return {}; }
  finally { if (db) try { db.close(); } catch { /* ignore */ } }
}

// Escape LIKE metacharacters so a temp path containing '_' or '%' (e.g. the
// Windows username 'umut_') can't act as a wildcard and over-match real projects.
function escapeLikePrefix(prefix) {
  return prefix.replace(/([\\%_])/g, '\\$1');
}

function cleanupPrefix(dbPath, prefix) {
  if (!dbPath) return;
  const like = escapeLikePrefix(prefix) + '%';
  let db;
  try {
    db = openDb(dbPath);
    for (const t of ['note_events', 'notes', 'changes', 'features', 'sessions', 'detection_log']) {
      try { db.prepare(`DELETE FROM ${t} WHERE project_path LIKE ? ESCAPE '\\'`).run(like); } catch { /* table absent */ }
    }
  } catch { /* ignore */ } finally { if (db) try { db.close(); } catch { /* ignore */ } }
}

function combinedCode(files) {
  return Object.entries(files || {})
    .map(([f, c]) => `// ${f}\n${c ?? ''}`)
    .join('\n\n');
}

function runOneArm(task, arm, replica, params) {
  const sb = runner.setupSandbox(params.base, task, arm, replica, params.fixturesRoot);
  // Sphere mode: seed the prior feature note for BOTH arms (identical DB state),
  // so the only difference between arms stays intervention_enabled. Throws loudly
  // on failure — a silently missing seed would produce garbage data.
  if (task.seedNotes && task.seedNotes.length) {
    runner.seedNotes(params.dbPath, sb.projectPath, task.seedNotes);
    // Seed feature centroids too (no-op unless the harness precomputed embeddings
    // for keyword-unreachable nodes) so the active arm's embedding resolver can
    // surface an arbitrary-node note in this fresh sandbox.
    runner.seedFeatures(params.dbPath, sb.projectPath, task.seedNotes);
  }
  const armResult = runner.runArm(task, sb.projectDir, params.model);
  sleepSync(1200); // let async post-edit hook flush
  const dbProxies = collectProxies(params.dbPath, sb.projectPath);
  const test = runner.runTest(task, sb.projectDir, params.fixturesRoot);
  const consistency = runner.runConsistency(task, sb.projectDir, params.fixturesRoot);
  // MAJOR-2: a timeout/kill (spawnStatus !== 0 / spawnError) leaves partial code
  // that must NOT be judged as a real solution. Fold spawn health into isError.
  const isError = armResult.envelope.isError || armResult.spawnStatus !== 0 || armResult.spawnError !== null;
  return {
    projectPath: sb.projectPath,
    envelope: armResult.envelope,
    clean: stripMarkers(combinedCode(armResult.files), (task.seedNotes || []).map((s) => s.nodeId)),
    proxies: { ...dbProxies, numTurns: armResult.envelope.numTurns, costUsd: armResult.envelope.costUsd, isError },
    testPass: test.pass,
    consistency,
    isError,
  };
}

// MAJOR-7 (sphere guard): a sphere pair is only a valid measurement if the seeded
// note actually reached the active arm. The read-gate swallows its own errors
// (non-blocking hook), so a silent surface failure still edits files —
// changeCount>0 keeps the MAJOR-5 wrong-DB guard quiet, and active≈passive would
// read as "DevGuard has no effect". Returns a warning string, or null when fine.
function sphereSurfaceWarning(task, activeArm) {
  if (!task.seedNotes || !task.seedNotes.length || activeArm.isError) return null;
  const surfaced = (activeArm.proxies.noteEvents && activeArm.proxies.noteEvents.surfaced) || 0;
  if (surfaced >= 1) return null;
  return `[ab-harness] WARNING: sphere task ${task.id}: active arm surfaced=0 — the seeded note never reached Claude; this pair's sphere result is INVALID.`;
}

function wilson(wins, n) {
  if (n === 0) return [0, 0];
  const z = 1.96, p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, +(center - margin).toFixed(4)), Math.min(1, +(center + margin).toFixed(4))];
}

function mean(arr) {
  const nums = arr.filter((x) => typeof x === 'number');
  return nums.length ? +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3) : null;
}

function computeSummary(pairs) {
  const s = { total_pairs: pairs.length, active_wins: 0, passive_wins: 0, ties: 0, inconsistent: 0, errored_pairs: 0 };
  // MAJOR-2: a pair where either arm errored/timed out is not a valid comparison —
  // exclude it from win-rate AND from proxy/test means.
  const valid = [];
  for (const p of pairs) {
    if (p.active.isError || p.passive.isError) { s.errored_pairs++; continue; }
    valid.push(p);
    if (p.verdict.pair_winner === 'active') s.active_wins++;
    else if (p.verdict.pair_winner === 'passive') s.passive_wins++;
    else s.ties++;
    if (p.verdict.consistent === false) s.inconsistent++;
  }
  const decisive = s.active_wins + s.passive_wins;
  s.active_win_rate = decisive ? +(s.active_wins / decisive).toFixed(4) : null;
  s.active_win_rate_ci_wilson = wilson(s.active_wins, decisive);
  s.valid_pairs = valid.length;
  s.test_pass_rate = {
    active: mean(valid.map((p) => (p.active.testPass === null ? null : p.active.testPass ? 1 : 0))),
    passive: mean(valid.map((p) => (p.passive.testPass === null ? null : p.passive.testPass ? 1 : 0))),
  };
  s.proxy_means = {
    cycleWarn: { active: mean(valid.map((p) => p.active.proxies.cycleWarnCount)), passive: mean(valid.map((p) => p.passive.proxies.cycleWarnCount)) },
    changeCount: { active: mean(valid.map((p) => p.active.proxies.changeCount)), passive: mean(valid.map((p) => p.passive.proxies.changeCount)) },
    sameFileMax: { active: mean(valid.map((p) => p.active.proxies.sameFileEditsMax)), passive: mean(valid.map((p) => p.passive.proxies.sameFileEditsMax)) },
    numTurns: { active: mean(valid.map((p) => p.active.proxies.numTurns)), passive: mean(valid.map((p) => p.passive.proxies.numTurns)) },
  };
  // Sphere mode: adherence to seeded decisions (mean() skips null scores, so
  // cycle-mode pairs don't dilute the mean) + surfaced-event counts, which
  // separate "note never reached the arm" from "note reached but was ignored".
  // surfaced is likewise restricted to seeded pairs — counting cycle pairs as 0
  // would dilute the sanity-check in a mixed run (MINOR-2).
  const consistencyScore = (a) => (a.consistency ? a.consistency.score : null);
  const surfacedCount = (p, a) => (p.seeded ? (a.proxies.noteEvents && a.proxies.noteEvents.surfaced) || 0 : null);
  s.consistency = {
    active: mean(valid.map((p) => consistencyScore(p.active))),
    passive: mean(valid.map((p) => consistencyScore(p.passive))),
  };
  s.surfaced = {
    active: mean(valid.map((p) => surfacedCount(p, p.active))),
    passive: mean(valid.map((p) => surfacedCount(p, p.passive))),
  };
  return s;
}

// Precompute feature-centroid embeddings for keyword-unreachable sphere tasks so
// the sync seedFeatures can insert them. encode() is async and loads MiniLM once;
// keyword-reachable tasks (the original bank) are skipped — their note surfaces via
// the keyword map, so no centroid and no resolver.
async function precomputeSeedFeatureEmbeddings(tasks) {
  const seeds = tasks
    .filter((t) => runner.taskNeedsEmbeddingResolver(t))
    .flatMap((t) => t.seedNotes || []);
  if (!seeds.length) return;
  const { loadModel, encode } = require('../src/engine/embedding');
  const model = await loadModel();
  if (!model) throw new Error('[ab-harness] embedding model unavailable — cannot seed centroids for keyword-unreachable sphere tasks (needed for surfacing)');
  for (const s of seeds) {
    const emb = await encode(s.seedFeatureText || s.text);
    if (!emb) throw new Error(`[ab-harness] failed to encode seed feature text for node ${s.nodeId}`);
    s._embedding = emb;
  }
  console.log(`[ab-harness] precomputed ${seeds.length} feature centroid(s) for embedding surfacing`);
}

async function main() {
  const params = parseArgs();
  const bank = JSON.parse(fs.readFileSync(params.tasksFile, 'utf8'));
  let tasks = bank.tasks || [];
  if (params.only.length) tasks = tasks.filter((t) => params.only.includes(t.id));
  await precomputeSeedFeatureEmbeddings(tasks);

  console.log(`[ab-harness] ${tasks.length} task(s) x ${params.replicas} replica(s), model=${params.model}, judge=${params.judgeModel}`);
  console.log(`[ab-harness] base=${params.base}`);
  console.log(`[ab-harness] prod DB=${params.dbPath}`);

  const pairs = [];
  try {
    for (const task of tasks) {
      for (let r = 1; r <= params.replicas; r++) {
        console.log(`\n[ab-harness] === ${task.id} replica ${r} ===`);
        console.log('  passive arm...');
        const passive = runOneArm(task, 'passive', r, params);
        cleanupPrefix(params.dbPath, passive.projectPath); // MAJOR-6: clear passive BEFORE active runs (symmetric isolation)
        console.log('  active arm...');
        const active = runOneArm(task, 'active', r, params);
        cleanupPrefix(params.dbPath, active.projectPath);
        // MAJOR-7: a sphere pair without a surfaced note is not a measurement.
        const surfaceWarn = sphereSurfaceWarning(task, active);
        if (surfaceWarn) console.warn(surfaceWarn);
        // MAJOR-2: skip judging an errored pair (partial code) — it won't count anyway.
        const errored = passive.isError || active.isError;
        const verdict = errored
          ? { pair_winner: 'tie', consistent: false, round1: null, round2: null, skipped: 'arm errored/timed out' }
          : (console.log('  judging (2 swapped rounds)...'), judge.judgePair(task, passive.clean, active.clean, params.judgeModel));
        console.log(`  -> winner=${verdict.pair_winner} consistent=${verdict.consistent} | test p=${passive.testPass} a=${active.testPass} | cons p=${passive.consistency.score}/${passive.consistency.total} a=${active.consistency.score}/${active.consistency.total} | err p=${passive.isError} a=${active.isError}`);
        pairs.push({
          task: task.id, replica: r,
          seeded: !!(task.seedNotes && task.seedNotes.length),
          surface_warning: surfaceWarn || undefined,
          passive: { proxies: passive.proxies, testPass: passive.testPass, consistency: passive.consistency, isError: passive.isError },
          active: { proxies: active.proxies, testPass: active.testPass, consistency: active.consistency, isError: active.isError },
          verdict,
        });
        // MAJOR-5: 0 DB changes in the first pair => likely wrong prod DB (getDbPath
        // mtime mismatch); DB proxies + cleanup would be silently wrong.
        if (pairs.length === 1 && ((passive.proxies.changeCount || 0) + (active.proxies.changeCount || 0)) === 0) {
          console.warn('[ab-harness] WARNING: 0 DB changes in first pair — likely reading the wrong devguard.db (getDbPath mtime mismatch). DB proxies/cleanup may target the wrong DB; set DG_AB_DB explicitly.');
        }
      }
    }
  } finally {
    // Final safety sweep — also runs when a loud seed failure or crash aborts the
    // loop mid-run, so ab_seed rows never linger in the production DB.
    cleanupPrefix(params.dbPath, normalizeBasePrefix(params.base));
  }

  const report = {
    meta: {
      product: 'DevGuard',
      experiment_type: 'A/B live claude -p (passive vs active intervention)',
      honesty_note: 'Proves output-quality effect of DevGuard intervention via blind pairwise judge. Not a substitute for real long-horizon usage.',
      measurable_components_note: 'Cycle-mode tasks measure pre-edit cycle warnings (in-session history). Sphere-mode tasks seed a prior feature note into BOTH arms\' DB rows, so the sphere read-gate is exercised; only the active arm has it surfaced.',
      sphere_mode_note: 'Sphere tasks measure decision-consistency transport (the memory channel): adherence to seeded prior decisions (consistency score) plus blind quality judgment with the decisions given to the judge as neutral project context. Not a proxy for general coding quality.',
      run_model: params.model, judge_model: params.judgeModel,
      permission_mode: 'acceptEdits',
      bias_mitigation: ['blind-judge', 'position-swap', 'code-only+strip'],
      isolation: 'strategy-B: unique project_path per run + per-pair cleanup',
    },
    generated_at: new Date().toISOString(),
    parameters: { tasks_file: params.tasksFile, n_replicas: params.replicas, only: params.only },
    pairs,
    summary: computeSummary(pairs),
  };
  fs.writeFileSync(params.outReport, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[ab-harness] report -> ${params.outReport}`);
  console.log('[ab-harness] summary:', JSON.stringify(report.summary, null, 2));
}

function normalizeBasePrefix(base) {
  try { return require('../src/engine/normalize-path').normalizeProjectPath(base); } catch { return base.replace(/\\/g, '/'); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseArgs, computeSummary, wilson, combinedCode, escapeLikePrefix, sphereSurfaceWarning };
