'use strict';

// Single-arm run mechanics for the A/B harness. Pure parts (buildConfigYaml,
// sandboxLayout, parseEnvelopeProxies, collectProxiesFromDb) are unit-tested;
// the live parts (setupSandbox fs+git, runArm claude -p spawn, runTest) are
// wired by the orchestrator and exercised by the smoke/pilot runs.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { normalizeProjectPath } = require('../src/engine/normalize-path');
const { sanitize } = require('../src/engine/sanitize');

const { buildIndex, resolveIndex } = require('../src/engine/keyword-index');

// A sphere task needs the embedding read-resolver when its seeded node is NOT
// reachable from the prompt by the free per-project keyword index built from the
// task's own seeded notes — exactly what the live resolver sees in the sandbox.
// Index-reachable tasks resolve for free and keep the resolver OFF (no MiniLM
// load). The old hardcoded keyword map is gone.
function taskNeedsEmbeddingResolver(task) {
  if (!task || !task.seedNotes || !task.seedNotes.length) return false;
  const index = buildIndex(task.seedNotes.map((s) => ({ node_id: s.nodeId, text: s.text })));
  const idx = resolveIndex(index, task.prompt || '', 0.75);
  return task.seedNotes.some((s) => idx !== s.nodeId);
}

// DevGuard reads devguard.config.yaml via cwd-upward traversal (config.js:100).
// The sandbox's own config is the nearest, so it wins over any ancestor config.
// The active arm additionally enables the embedding resolver ONLY when the task's
// seeded node isn't keyword-reachable: a fresh sandbox has no feature map, so an
// arbitrary-node note can only surface via prompt→centroid argmax (the harness
// seeds that centroid in seedFeatures). Passive stays fully dark.
function buildConfigYaml(arm, task) {
  const active = arm === 'active';
  const resolver = active && taskNeedsEmbeddingResolver(task);
  return `intervention_enabled: ${active}\nsphere_read_resolver_enabled: ${resolver}\n`;
}

// Unique directory per (task, arm, replica) => unique project_path, so DevGuard's
// multi-tenant project_path filter isolates every run (Strategy B).
function sandboxLayout(base, taskId, arm, replica) {
  const dir = path.join(base, taskId, arm, String(replica));
  return { dir, projectDir: path.join(dir, 'project') };
}

// Files that exist in the fixture but must NOT be visible to Claude in the
// sandbox: the hidden acceptance test and the hidden consistency checker.
function hiddenFiles(task) {
  const files = [];
  if (task.test && task.test.file) files.push(task.test.file);
  if (task.consistencyTest && task.consistencyTest.file) files.push(task.consistencyTest.file);
  return files;
}

// Parse "CHECK <id> PASS|FAIL" lines emitted by a fixture's hidden consistency
// checker. No CHECK lines (checker crashed before printing) -> score null, so a
// broken checker is distinguishable from a real 0-of-N score.
function parseConsistencyOutput(stdout) {
  const checks = {};
  for (const m of String(stdout || '').matchAll(/^CHECK (\S+) (PASS|FAIL)\s*$/gm)) {
    checks[m[1]] = m[2] === 'PASS';
  }
  const ids = Object.keys(checks);
  if (ids.length === 0) return { score: null, total: 0, checks: {} };
  return { score: ids.filter((k) => checks[k]).length, total: ids.length, checks };
}

// Seed prior feature notes into the production DB under the sandbox's unique
// project_path BEFORE the arm runs — the sphere read-gate surfaces them in the
// active arm and stays silent in the passive arm. Seeding failures THROW: the
// harness is a measurement tool, and a silently missing seed would produce
// garbage data (the hooks' non-blocking-fail rule does not apply here).
// fileMustExist guards against silently creating a fresh empty DB at a wrong path.
function seedNotes(dbPath, projectPath, seeds) {
  if (!dbPath) throw new Error('seedNotes: no DB path (set DG_AB_DB explicitly)');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    // Concurrent group runs share this production DB; wait-and-retry on a brief
    // lock instead of throwing SQLITE_BUSY (which would abort the whole group).
    try { db.pragma('busy_timeout = 8000'); } catch { /* ignore */ }
    const stmt = db.prepare(`INSERT INTO notes
      (project_path, file, node_id, source, confidence_level, note_text)
      VALUES (?, ?, ?, 'ab_seed', 3, ?)`);
    // Same sanitize() as production insertNote (db.js), so a seeded note is
    // stored byte-identically to a real one.
    for (const s of seeds) stmt.run(projectPath, s.file, sanitize(s.nodeId) || null, sanitize(s.text));
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// Seed a feature centroid for each note's node so the embedding read-resolver can
// surface it (a fresh sandbox has no feature map, so prompt→centroid argmax is the
// only way an arbitrary-node note reaches Claude). The centroid is precomputed by
// the harness (encode is async); seeds without a precomputed _embedding are skipped
// — keyword-reachable tasks don't need one. project_path is unique per run, so a
// plain INSERT never collides on features' UNIQUE(project_path, node_id).
function seedFeatures(dbPath, projectPath, seeds) {
  if (!dbPath) throw new Error('seedFeatures: no DB path (set DG_AB_DB explicitly)');
  const withEmb = (seeds || []).filter((s) => s._embedding);
  if (!withEmb.length) return;
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    try { db.pragma('busy_timeout = 8000'); } catch { /* ignore */ }
    const stmt = db.prepare(`INSERT INTO features
      (project_path, continent, country, node_id, centroid_embedding, member_count)
      VALUES (?, ?, ?, ?, ?, 1)`);
    for (const s of withEmb) {
      const i = String(s.nodeId).indexOf('/');
      const continent = i >= 0 ? s.nodeId.slice(0, i) : s.nodeId;
      const country = i >= 0 ? s.nodeId.slice(i + 1) : s.nodeId;
      stmt.run(projectPath, sanitize(continent) || null, sanitize(country) || null, sanitize(s.nodeId) || null, s._embedding);
    }
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// Proxies available straight from the `claude -p --output-format json` envelope
// (shape verified via smoke probe): no DB query needed.
function parseEnvelopeProxies(stdout) {
  let env = null;
  try { env = JSON.parse(String(stdout).trim()); } catch { /* not an envelope */ }
  if (!env || typeof env !== 'object') {
    return { isError: true, numTurns: null, costUsd: null, outputTokens: null, reply: typeof stdout === 'string' ? stdout : '', permissionDenials: null };
  }
  return {
    isError: env.is_error === true,
    numTurns: typeof env.num_turns === 'number' ? env.num_turns : null,
    costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null,
    outputTokens: env.usage && typeof env.usage.output_tokens === 'number' ? env.usage.output_tokens : null,
    reply: typeof env.result === 'string' ? env.result : '',
    permissionDenials: Array.isArray(env.permission_denials) ? env.permission_denials.length : null,
  };
}

// Secondary proxies from the DevGuard DB, scoped to this run's unique
// project_path. `db` is a readonly better-sqlite3 handle (NOT the db.js singleton
// — that would lock onto the wrong path in a long-lived orchestrator, plan R4).
function collectProxiesFromDb(db, projectPath) {
  const one = (sql, ...p) => { try { return db.prepare(sql).get(...p) || {}; } catch { return {}; } };
  const changeCount = one('SELECT COUNT(*) c FROM changes WHERE project_path=?', projectPath).c || 0;
  const distinctFilesEdited = one('SELECT COUNT(DISTINCT file) c FROM changes WHERE project_path=?', projectPath).c || 0;
  const sameFileEditsMax = one('SELECT MAX(cnt) m FROM (SELECT COUNT(*) cnt FROM changes WHERE project_path=? GROUP BY file)', projectPath).m || 0;
  const cycleWarnCount = one("SELECT COUNT(*) c FROM detection_log WHERE project_path=? AND decision='warn'", projectPath).c || 0;
  const noteEvents = {};
  try {
    for (const row of db.prepare('SELECT event_type, COUNT(*) c FROM note_events WHERE project_path=? GROUP BY event_type').all(projectPath)) {
      noteEvents[row.event_type] = row.c;
    }
  } catch { /* table may be absent */ }
  return { changeCount, distinctFilesEdited, sameFileEditsMax, cycleWarnCount, noteEvents };
}

// --- live parts (not unit-tested; exercised by smoke/pilot) ---

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function git(cwd, args) {
  try { spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, shell: true }); } catch { /* best-effort */ }
}

// Create a fresh sandbox for one (task, arm, replica): copy fixtures, write the
// arm's config, git-init a clean baseline. Returns projectDir + normalized
// project_path (the DevGuard multi-tenant key for proxy collection).
function setupSandbox(base, task, arm, replica, fixturesRoot) {
  const layout = sandboxLayout(base, task.id, arm, replica);
  fs.mkdirSync(layout.projectDir, { recursive: true });
  copyDir(path.join(fixturesRoot, task.fixtureDir), layout.projectDir);
  // Remove hidden graders (acceptance test + consistency checker) from the
  // sandbox BEFORE Claude runs, so it can't read/game them (and before the
  // baseline commit, so git history omits them too).
  for (const f of hiddenFiles(task)) {
    try { fs.rmSync(path.join(layout.projectDir, f)); } catch { /* not present */ }
  }
  fs.writeFileSync(path.join(layout.projectDir, 'devguard.config.yaml'), buildConfigYaml(arm, task), 'utf8');
  git(layout.projectDir, ['init', '-q']);
  git(layout.projectDir, ['add', '-A']);
  git(layout.projectDir, ['-c', 'user.email=ab@harness', '-c', 'user.name=ab', 'commit', '-q', '-m', 'baseline']);
  return { projectDir: layout.projectDir, projectPath: normalizeProjectPath(layout.projectDir) };
}

// Run one arm: spawn `claude -p` with the prompt on STDIN (no arg escaping),
// then read back the entry files Claude produced.
function runArm(task, projectDir, model) {
  const args = ['-p', '--model', model, '--output-format', 'json',
    '--permission-mode', 'acceptEdits', '--allowedTools', (task.allowedTools || ['Read', 'Edit', 'Write', 'Bash']).join(',')];
  const r = spawnSync('claude', args, {
    input: task.prompt, cwd: projectDir, env: { ...process.env },
    encoding: 'utf8', timeout: task.timeoutMs || 240000, shell: true, maxBuffer: 20 * 1024 * 1024,
  });
  const env = parseEnvelopeProxies(r.stdout || '');
  const files = {};
  for (const f of task.entryFiles || []) {
    try { files[f] = fs.readFileSync(path.join(projectDir, f), 'utf8'); } catch { files[f] = null; }
  }
  return { envelope: env, files, spawnStatus: r.status, spawnError: r.error ? r.error.code : null };
}

// Run the task's hidden test against the final code. The test is copied in from
// the fixture (never present during Claude's run), executed, then removed.
// pass = exit 0.
function runTest(task, projectDir, fixturesRoot) {
  if (!task.test || !task.test.cmd || !task.test.file) return { pass: null, output: '' };
  const dst = path.join(projectDir, task.test.file);
  try { fs.copyFileSync(path.join(fixturesRoot, task.fixtureDir, task.test.file), dst); }
  catch { return { pass: null, output: 'test fixture missing' }; }
  const r = spawnSync(task.test.cmd, { cwd: projectDir, encoding: 'utf8', timeout: 60000, shell: true });
  try { fs.rmSync(dst); } catch { /* ignore */ }
  return { pass: r.status === 0, output: ((r.stdout || '') + (r.stderr || '')).slice(0, 2000) };
}

// Run the task's hidden consistency checker (adherence to the seeded prior
// decisions) against the final code. Same copy-run-remove mechanics as runTest.
function runConsistency(task, projectDir, fixturesRoot) {
  if (!task.consistencyTest || !task.consistencyTest.cmd || !task.consistencyTest.file) {
    return { score: null, total: 0, checks: {}, output: '' };
  }
  const dst = path.join(projectDir, task.consistencyTest.file);
  try { fs.copyFileSync(path.join(fixturesRoot, task.fixtureDir, task.consistencyTest.file), dst); }
  catch { return { score: null, total: 0, checks: {}, output: 'consistency fixture missing' }; }
  const r = spawnSync(task.consistencyTest.cmd, { cwd: projectDir, encoding: 'utf8', timeout: 60000, shell: true });
  try { fs.rmSync(dst); } catch { /* ignore */ }
  const parsed = parseConsistencyOutput(r.stdout || '');
  return { ...parsed, output: ((r.stdout || '') + (r.stderr || '')).slice(0, 2000) };
}

module.exports = {
  buildConfigYaml, taskNeedsEmbeddingResolver, sandboxLayout, parseEnvelopeProxies, collectProxiesFromDb,
  hiddenFiles, parseConsistencyOutput, seedNotes, seedFeatures,
  setupSandbox, runArm, runTest, runConsistency,
};
