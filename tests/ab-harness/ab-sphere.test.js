import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { seedNotes, hiddenFiles, runConsistency, parseConsistencyOutput } = require('../../tools/dg-ab-runner');
const { computeSummary, sphereSurfaceWarning } = require('../../tools/dg-ab-harness');
const { stripMarkers } = require('../../tools/lib/ab-strip');
const { resolveNodeId } = require('../../src/engine/keyword-node-map');
const { buildIndex, resolveIndex } = require('../../src/engine/keyword-index');
const { isValidNodeId } = require('../../src/engine/node-taxonomy');

// V13 notes DDL (mirrors db.js MIGRATION_V13_SQL) — the seed INSERT must satisfy
// every NOT NULL and land as a head row (superseded_by IS NULL).
const NOTES_DDL = `CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  related_change_id INTEGER,
  file TEXT NOT NULL,
  lines_start INTEGER,
  lines_end INTEGER,
  node_id TEXT,
  source TEXT NOT NULL,
  confidence_level INTEGER NOT NULL,
  note_text TEXT NOT NULL,
  trigger_data TEXT,
  superseded_by INTEGER,
  dismissed_at DATETIME,
  dismissed_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

// Same query as db.js getHeadNoteByNode — the seed must be visible to the
// production surface path exactly this way.
function headNote(dbPath, projectPath, nodeId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(
      `SELECT * FROM notes
       WHERE project_path = ? AND node_id = ? AND superseded_by IS NULL
       ORDER BY id DESC LIMIT 1`
    ).get(projectPath, nodeId);
  } finally { db.close(); }
}

describe('ab-runner: seedNotes', () => {
  let tmp, dbPath;
  const PP = 'C:/tmp/dg-ab/sphere-filter/active/1/project';
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-ab-sphere-'));
    dbPath = path.join(tmp, 'devguard.db');
    const db = new Database(dbPath);
    db.exec(NOTES_DDL);
    db.close();
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('inserts a head note the production surface query can see', () => {
    seedNotes(dbPath, PP, [{ nodeId: 'ui_ux/filter', file: 'filter.js', text: 'Title matching stays case-sensitive.' }]);
    const head = headNote(dbPath, PP, 'ui_ux/filter');
    expect(head).toBeTruthy();
    expect(head.note_text).toBe('Title matching stays case-sensitive.');
    expect(head.source).toBe('ab_seed');
    expect(head.superseded_by).toBeNull();
    expect(head.file).toBe('filter.js');
  });

  it('is tenant-scoped: a different project_path sees no head', () => {
    seedNotes(dbPath, PP, [{ nodeId: 'ui_ux/filter', file: 'filter.js', text: 'x' }]);
    expect(headNote(dbPath, 'C:/other/project', 'ui_ux/filter')).toBeUndefined();
  });

  it('throws loudly when the DB file does not exist (never creates a fresh empty DB)', () => {
    expect(() => seedNotes(path.join(tmp, 'missing.db'), PP, [{ nodeId: 'a/b', file: 'f.js', text: 'x' }])).toThrow();
    expect(fs.existsSync(path.join(tmp, 'missing.db'))).toBe(false);
    expect(() => seedNotes(null, PP, [{ nodeId: 'a/b', file: 'f.js', text: 'x' }])).toThrow(/DB path/);
  });

  it('throws loudly when the notes table is absent (wrong DB)', () => {
    const bare = path.join(tmp, 'bare.db');
    new Database(bare).close(); // valid sqlite file, no schema
    expect(() => seedNotes(bare, PP, [{ nodeId: 'a/b', file: 'f.js', text: 'x' }])).toThrow();
  });
});

describe('ab-runner: hiddenFiles', () => {
  it('lists both the hidden test and the hidden consistency check', () => {
    expect(hiddenFiles({ test: { file: 'test.js' }, consistencyTest: { file: 'consistency.js' } }))
      .toEqual(['test.js', 'consistency.js']);
  });
  it('handles tasks with only a test, or neither', () => {
    expect(hiddenFiles({ test: { file: 'test.js' } })).toEqual(['test.js']);
    expect(hiddenFiles({})).toEqual([]);
  });
});

describe('ab-runner: parseConsistencyOutput', () => {
  it('parses CHECK lines into score/total/checks', () => {
    const out = parseConsistencyOutput('setup ok\nCHECK C1 PASS\nCHECK C2 FAIL\nCHECK C3 PASS\ndone');
    expect(out).toEqual({ score: 2, total: 3, checks: { C1: true, C2: false, C3: true } });
  });
  it('returns null score for output with no CHECK lines', () => {
    expect(parseConsistencyOutput('TypeError: boom')).toEqual({ score: null, total: 0, checks: {} });
    expect(parseConsistencyOutput('')).toEqual({ score: null, total: 0, checks: {} });
  });
});

describe('ab-runner: runConsistency (real spawn against a temp fixture)', () => {
  let tmp, fixturesRoot, projectDir;
  const CHECKER = [
    "console.log('CHECK C1 PASS');",
    "console.log('CHECK C2 FAIL');",
    'process.exit(1);',
  ].join('\n');
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-ab-cons-'));
    fixturesRoot = path.join(tmp, 'fixtures-root');
    projectDir = path.join(tmp, 'project');
    fs.mkdirSync(path.join(fixturesRoot, 'fx'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(fixturesRoot, 'fx', 'consistency.js'), CHECKER, 'utf8');
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('copies the checker in, runs it, parses CHECK lines, and removes it again', () => {
    const task = { fixtureDir: 'fx', consistencyTest: { cmd: 'node consistency.js', file: 'consistency.js' } };
    const r = runConsistency(task, projectDir, fixturesRoot);
    expect(r.score).toBe(1);
    expect(r.total).toBe(2);
    expect(r.checks).toEqual({ C1: true, C2: false });
    expect(fs.existsSync(path.join(projectDir, 'consistency.js'))).toBe(false);
  });

  it('returns null score when the task has no consistencyTest', () => {
    expect(runConsistency({ fixtureDir: 'fx' }, projectDir, fixturesRoot).score).toBeNull();
  });
});

describe('ab-harness: computeSummary consistency + surfaced additions', () => {
  const arm = (over = {}) => ({
    proxies: { cycleWarnCount: 0, changeCount: 1, sameFileEditsMax: 1, numTurns: 2, noteEvents: {}, ...(over.proxies || {}) },
    testPass: true, isError: false,
    consistency: { score: null, total: 0 },
    ...over,
  });
  const pair = (aOver, pOver, winner = 'tie', seeded = true) => ({
    task: 't', replica: 1, seeded,
    active: arm(aOver), passive: arm(pOver),
    verdict: { pair_winner: winner, consistent: true },
  });

  it('averages consistency scores per arm over valid pairs', () => {
    const s = computeSummary([
      pair({ consistency: { score: 3, total: 3 } }, { consistency: { score: 1, total: 3 } }),
      pair({ consistency: { score: 2, total: 3 } }, { consistency: { score: 0, total: 3 } }),
    ]);
    expect(s.consistency.active).toBeCloseTo(2.5);
    expect(s.consistency.passive).toBeCloseTo(0.5);
  });

  it('skips null consistency scores (cycle-mode tasks) instead of counting them as 0', () => {
    const s = computeSummary([
      pair({ consistency: { score: 3, total: 3 } }, { consistency: { score: 0, total: 3 } }),
      pair({ consistency: { score: null, total: 0 } }, { consistency: { score: null, total: 0 } }),
    ]);
    expect(s.consistency.active).toBeCloseTo(3);
    expect(s.consistency.passive).toBeCloseTo(0);
  });

  it('averages surfaced note-events per arm (missing noteEvents counts as 0)', () => {
    const s = computeSummary([
      pair({ proxies: { noteEvents: { surfaced: 1 } } }, { proxies: { noteEvents: {} } }),
      pair({ proxies: { noteEvents: { surfaced: 1 } } }, { proxies: {} }),
    ]);
    expect(s.surfaced.active).toBeCloseTo(1);
    expect(s.surfaced.passive).toBeCloseTo(0);
  });

  it('excludes errored pairs from consistency and surfaced means', () => {
    const errored = pair({ consistency: { score: 3, total: 3 }, isError: true }, { consistency: { score: 3, total: 3 } });
    const ok = pair({ consistency: { score: 1, total: 3 }, proxies: { noteEvents: { surfaced: 1 } } }, { consistency: { score: 0, total: 3 } });
    const s = computeSummary([errored, ok]);
    expect(s.consistency.active).toBeCloseTo(1);
    expect(s.surfaced.active).toBeCloseTo(1);
  });

  it('excludes unseeded (cycle-mode) pairs from the surfaced mean instead of diluting it with 0s', () => {
    const sphere = pair({ proxies: { noteEvents: { surfaced: 1 } } }, {});
    const cycle = pair({}, {}, 'tie', false);
    const s = computeSummary([sphere, cycle]);
    expect(s.surfaced.active).toBeCloseTo(1); // NOT 0.5
    const allCycle = computeSummary([pair({}, {}, 'tie', false)]);
    expect(allCycle.surfaced.active).toBeNull();
  });
});

describe('ab-harness: sphereSurfaceWarning (MAJOR-7 guard)', () => {
  const task = { id: 'sphere-filter', seedNotes: [{ nodeId: 'ui_ux/filter', file: 'habits.js', text: 'x' }] };
  const armWith = (noteEvents, isError = false) => ({ isError, proxies: { noteEvents } });

  it('warns when a sphere active arm never had the note surfaced', () => {
    expect(sphereSurfaceWarning(task, armWith({}))).toMatch(/surfaced=0.*INVALID/);
    expect(sphereSurfaceWarning(task, armWith(undefined))).toMatch(/INVALID/);
  });

  it('stays quiet when the note surfaced, on errored arms, and on non-sphere tasks', () => {
    expect(sphereSurfaceWarning(task, armWith({ surfaced: 1 }))).toBeNull();
    expect(sphereSurfaceWarning(task, armWith({}, true))).toBeNull(); // errored pair is excluded anyway
    expect(sphereSurfaceWarning({ id: 'cycle-x' }, armWith({}))).toBeNull();
  });
});

describe('ab-strip: sphere additions', () => {
  it('strips run-specific seeded node_ids without killing the line', () => {
    const out = stripMarkers('// ui_ux/filter: case-insensitive per project convention\ncode();', ['ui_ux/filter']);
    expect(out).not.toContain('ui_ux/filter');
    expect(out).toContain('case-insensitive per project convention');
    expect(out).toContain('code();');
  });

  it('keeps plural "prior notes"/"feature notes" lines (ordinary domain phrases)', () => {
    const code = '// filter prior notes by title\n// feature notes are matched on title\ncode();';
    expect(stripMarkers(code)).toBe(code);
  });

  it('still drops singular injected-guidance paraphrase lines', () => {
    const out = stripMarkers('// per the prior note, matching stays case-insensitive\ncode();');
    expect(out).not.toContain('prior note');
    expect(out).toContain('code();');
  });
});

describe('tasks.json: sphere task bank alignment (regression guard)', () => {
  const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
  const sphere = bank.tasks.filter((t) => t.mode === 'sphere');

  it('has at least 3 sphere tasks', () => {
    expect(sphere.length).toBeGreaterThanOrEqual(3);
  });

  it('every sphere prompt is surfaceable to its seeded node (keyword map, per-project index, or embedding-eligible)', () => {
    // The 3-layer resolver: frozen keyword map -> free per-project keyword index
    // (built from the seeded notes) -> embedding fallback. A task surfaces if any
    // layer places it. The two model-free layers are checked here; a task that
    // defers on both must carry a seedFeatureText so the harness seeds the centroid
    // the embedding fallback needs.
    const index = buildIndex(sphere.map((t) => ({ node_id: t.seedNotes[0].nodeId, text: t.seedNotes[0].text })));
    for (const t of sphere) {
      expect(t.seedNotes && t.seedNotes.length, `${t.id} needs seedNotes`).toBeTruthy();
      const node = t.seedNotes[0].nodeId;
      const kw = resolveNodeId(t.prompt);
      const idx = resolveIndex(index, t.prompt, 0.75);
      const surfaceable = kw === node || idx === node || !!t.seedNotes[0].seedFeatureText;
      expect(surfaceable, `${t.id}: not surfaceable — keyword=${kw} index=${idx} seedFeatureText=${!!t.seedNotes[0].seedFeatureText}`).toBe(true);
      for (const s of t.seedNotes) {
        expect(isValidNodeId(s.nodeId), `${t.id}: invalid node_id ${s.nodeId}`).toBe(true);
        expect(typeof s.file).toBe('string');
        expect(s.text).not.toMatch(/devguard|dg-note/i); // seed text must not name the product
      }
    }
  });

  it('every sphere task ships hidden test + consistency files in its fixture', () => {
    for (const t of sphere) {
      const fx = path.join(__dirname, t.fixtureDir);
      expect(fs.existsSync(path.join(fx, t.test.file)), `${t.id}: missing ${t.test.file}`).toBe(true);
      expect(fs.existsSync(path.join(fx, t.consistencyTest.file)), `${t.id}: missing ${t.consistencyTest.file}`).toBe(true);
      expect(Array.isArray(t.entryFiles) && t.entryFiles.length > 0).toBe(true);
    }
  });
});
