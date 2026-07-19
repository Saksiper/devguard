import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let dbDir;        // CLAUDE_PLUGIN_DATA — where devguard.db lives
let projectsDir;  // synthetic ~/.claude/projects root

// Modules in backfill's require graph. Bust them all so the freshly required
// db singleton is shared between backfill.js and the test's own db handle.
const GRAPH = [
  '../../src/engine/backfill',
  '../../src/engine/db',
  '../../src/engine/transcript-parser',
  '../../src/engine/normalize-path',
  '../../src/engine/sanitize',
  '../../src/engine/debug-log',
];

function bust() {
  for (const m of GRAPH) delete require.cache[require.resolve(m)];
}

function loadBackfill() {
  bust();
  return require('../../src/engine/backfill');
}

function loadDb() {
  return require('../../src/engine/db');
}

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-backfill-db-'));
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-backfill-proj-'));
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
});

afterEach(() => {
  try { loadDb().closeDb(); } catch { /* cleanup */ }
  bust();
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const dir of [dbDir, projectsDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
    }
  }
});

const CWD = 'C:\\Users\\umut_\\proj';
const PROJECT = 'C:/Users/umut_/proj';
const FILE_IN = 'C:\\Users\\umut_\\proj\\src\\index.js';
const FILE_OUT = 'C:/Users/umut_/proj/src/index.js';
const TS = '2024-03-10T08:30:00Z';

function assistantEdit(id, name, input, extra = {}) {
  return {
    type: 'assistant',
    cwd: CWD,
    timestamp: TS,
    sessionId: 'sess-bf',
    version: '1.0.0',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ...extra,
  };
}

function userResult(toolUseId, isError) {
  const item = { type: 'tool_result', tool_use_id: toolUseId };
  if (isError) item.is_error = true;
  return { type: 'user', message: { role: 'user', content: [item] } };
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'));
}

// A transcript with two good edits (Edit + Write) and one failed edit (is_error).
function seedTranscript(filePath, cwd = CWD) {
  writeJsonl(filePath, [
    assistantEdit('tool_ok_1', 'Edit', { file_path: FILE_IN, old_string: 'a', new_string: 'b' }, { cwd }),
    userResult('tool_ok_1', false),
    assistantEdit('tool_bad', 'Edit', { file_path: FILE_IN, old_string: 'c', new_string: 'd' }, { cwd }),
    userResult('tool_bad', true),
    assistantEdit('tool_ok_2', 'Write', { file_path: FILE_IN, content: 'module.exports = {};' }, { cwd }),
    userResult('tool_ok_2', false),
  ]);
}

describe('runBackfill — basic ingestion', () => {
  it.skipIf(process.platform !== 'win32')('inserts the successful edits, excludes the failed one, with backfill provenance', () => {
    const fp = path.join(projectsDir, 'sub', 't.jsonl');
    seedTranscript(fp);

    const { runBackfill } = loadBackfill();
    const stats = runBackfill({ projectsDir });

    expect(stats.filesScanned).toBe(1);
    expect(stats.editsInserted).toBe(2); // Edit + Write; failed Edit excluded
    expect(stats.editsSkipped).toBe(0);
    expect(stats.errors).toBe(0);

    const rows = loadDb().getDb(PROJECT).getChanges();
    expect(rows).toHaveLength(2);
    const ids = rows.map(r => r.tool_use_id).sort();
    expect(ids).toEqual(['tool_ok_1', 'tool_ok_2']);
    expect(rows.every(r => r.source === 'transcript_backfill')).toBe(true);
    expect(rows.every(r => r.file === FILE_OUT)).toBe(true);
    expect(rows.every(r => r.session_id === 'sess-bf')).toBe(true);
    // Historical instant preserved (NOT replaced with CURRENT_TIMESTAMP),
    // normalized to sqlite datetime format at the DB layer.
    expect(rows.every(r => r.timestamp === '2024-03-10 08:30:00')).toBe(true);
    // The failed edit never landed.
    expect(rows.some(r => r.tool_use_id === 'tool_bad')).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('recurses into subagents/ subfolders', () => {
    const fp = path.join(projectsDir, 'projA', 'subagents', 'agent.jsonl');
    writeJsonl(fp, [
      assistantEdit('sub_1', 'Edit', { file_path: FILE_IN, old_string: 'x', new_string: 'y' }, { isSidechain: true }),
      userResult('sub_1', false),
    ]);

    const { runBackfill } = loadBackfill();
    const stats = runBackfill({ projectsDir });
    expect(stats.editsInserted).toBe(1);
    expect(loadDb().getDb(PROJECT).getChanges()).toHaveLength(1);
  });

  it('returns zeros (no throw) when projectsDir does not exist', () => {
    const { runBackfill } = loadBackfill();
    const stats = runBackfill({ projectsDir: path.join(projectsDir, 'does-not-exist') });
    expect(stats).toEqual({ filesScanned: 0, editsInserted: 0, editsSkipped: 0, editsExcluded: 0, errors: 0 });
  });
});

// Windows-form transcript cwd/paths in the fixtures; on Linux they normalize to ''
// and route nowhere, so these engine tests are win32-only (real POSIX paths work).
describe.skipIf(process.platform !== 'win32')('runBackfill — idempotency (cursor + unique index)', () => {
  it('re-run inserts nothing and skips the already-imported edits', () => {
    const fp = path.join(projectsDir, 't.jsonl');
    seedTranscript(fp);

    const { runBackfill } = loadBackfill();
    const first = runBackfill({ projectsDir });
    expect(first.editsInserted).toBe(2);

    // Second run: the cursor is at EOF, so extractEdits yields nothing — no new
    // inserts, no skips (cursor short-circuits before any insert is attempted).
    const second = runBackfill({ projectsDir });
    expect(second.editsInserted).toBe(0);
    expect(second.filesScanned).toBe(0); // file.size <= cursor, not re-scanned
    expect(loadDb().getDb(PROJECT).getChanges()).toHaveLength(2);
  });

  it('unique index skips duplicates when the cursor is reset (forced re-scan)', () => {
    const fp = path.join(projectsDir, 't.jsonl');
    seedTranscript(fp);

    const { runBackfill } = loadBackfill();
    expect(runBackfill({ projectsDir }).editsInserted).toBe(2);

    // Reset the cursor so the file is fully re-scanned. The unique index on
    // (project_path, tool_use_id) now makes every insert a skip.
    loadDb().getDb(PROJECT).setBackfillCursor(fp, 0);
    const second = runBackfill({ projectsDir });
    expect(second.filesScanned).toBe(1);
    expect(second.editsInserted).toBe(0);
    expect(second.editsSkipped).toBe(2);
    expect(loadDb().getDb(PROJECT).getChanges()).toHaveLength(2);
  });
});

describe.skipIf(process.platform !== 'win32')('runBackfill — maxEdits budget', () => {
  it('stops at the budget and does NOT advance the cursor for the truncated file', () => {
    const fp = path.join(projectsDir, 't.jsonl');
    seedTranscript(fp); // 2 importable edits

    const { runBackfill } = loadBackfill();
    const stats = runBackfill({ projectsDir, maxEdits: 1 });
    expect(stats.editsInserted).toBe(1);

    // Cursor NOT advanced (still 0) so the remainder is picked up next run.
    expect(loadDb().getDb(PROJECT).getBackfillCursor(fp)).toBe(0);
    expect(loadDb().getDb(PROJECT).getChanges()).toHaveLength(1);

    // Next run with a fresh budget imports the remaining edit (no duplicate of
    // the first, thanks to the unique index).
    const resume = runBackfill({ projectsDir, maxEdits: 500 });
    expect(resume.editsInserted).toBe(1);
    expect(resume.editsSkipped).toBe(1); // the already-imported first edit
    expect(loadDb().getDb(PROJECT).getChanges()).toHaveLength(2);
    // Cursor now advanced to EOF.
    expect(loadDb().getDb(PROJECT).getBackfillCursor(fp)).toBe(fs.statSync(fp).size);
  });
});

describe.skipIf(process.platform !== 'win32')('runBackfill — cross-project isolation', () => {
  it('routes edits to the correct project_path based on transcript cwd', () => {
    const projectB = 'C:/Users/umut_/other';
    const cwdB = 'C:\\Users\\umut_\\other';
    const fileB = 'C:\\Users\\umut_\\other\\app.js';

    writeJsonl(path.join(projectsDir, 'a.jsonl'), [
      assistantEdit('a_1', 'Edit', { file_path: FILE_IN, old_string: '1', new_string: '2' }),
      userResult('a_1', false),
    ]);
    writeJsonl(path.join(projectsDir, 'b.jsonl'), [
      assistantEdit('b_1', 'Edit', { file_path: fileB, old_string: '3', new_string: '4' }, { cwd: cwdB }),
      userResult('b_1', false),
    ]);

    const { runBackfill } = loadBackfill();
    const stats = runBackfill({ projectsDir });
    expect(stats.editsInserted).toBe(2);

    const rowsA = loadDb().getDb(PROJECT).getChanges();
    const rowsB = loadDb().getDb(projectB).getChanges();
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].tool_use_id).toBe('a_1');
    expect(rowsB[0].tool_use_id).toBe('b_1');
  });
});

// Live hooks skip excluded paths (post-edit → isExcluded); backfill must apply the
// same filter or it re-imports exactly what live capture deliberately drops.
describe.skipIf(process.platform !== 'win32')('runBackfill — live-capture path-exclusion parity', () => {
  it('skips edits under excluded segments and counts them as editsExcluded', () => {
    const fp = path.join(projectsDir, 't.jsonl');
    writeJsonl(fp, [
      assistantEdit('tool_excl_nm', 'Edit', { file_path: 'C:\\Users\\umut_\\proj\\node_modules\\pkg\\index.js', old_string: 'a', new_string: 'b' }),
      userResult('tool_excl_nm', false),
      assistantEdit('tool_excl_claude', 'Write', { file_path: 'C:\\Users\\umut_\\.claude\\projects\\x\\memory\\notes.md', content: 'x' }),
      userResult('tool_excl_claude', false),
      assistantEdit('tool_ok_incl', 'Edit', { file_path: FILE_IN, old_string: 'a', new_string: 'b' }),
      userResult('tool_ok_incl', false),
    ]);

    const { runBackfill } = loadBackfill();
    const stats = runBackfill({ projectsDir });

    expect(stats.editsInserted).toBe(1);
    expect(stats.editsExcluded).toBe(2);
    expect(stats.errors).toBe(0);

    const rows = loadDb().getDb(PROJECT).getChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_use_id).toBe('tool_ok_incl');
  });
});
