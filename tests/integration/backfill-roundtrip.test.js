import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let dbDir;
let projectsDir;

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

function load() {
  bust();
  return {
    runBackfill: require('../../src/engine/backfill').runBackfill,
    db: require('../../src/engine/db'),
  };
}

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-bf-rt-db-'));
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-bf-rt-proj-'));
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  bust();
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const dir of [dbDir, projectsDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL */ }
    }
  }
});

const CWD = 'C:\\Users\\umut_\\roundtrip';
const PROJECT = 'C:/Users/umut_/roundtrip';
const FILE_IN = 'C:\\Users\\umut_\\roundtrip\\config.js';
const FILE_OUT = 'C:/Users/umut_/roundtrip/config.js';

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'));
}

// Windows-form transcript cwd/paths in the fixtures; on Linux they normalize to ''
// and route nowhere, so this end-to-end test is win32-only (real POSIX paths work).
describe.skipIf(process.platform !== 'win32')('backfill end-to-end: transcript -> runBackfill -> getChanges', () => {
  it('surfaces backfilled edits with correct file/project and sanitizes secrets', () => {
    const secret = 'sk-' + 'A'.repeat(30);
    const fp = path.join(projectsDir, 'project-hash', 'session.jsonl');
    writeJsonl(fp, [
      {
        type: 'assistant',
        cwd: CWD,
        timestamp: '2024-05-01T12:00:00Z',
        sessionId: 'rt-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_secret',
            name: 'Write',
            input: { file_path: FILE_IN, content: `const KEY = "${secret}";` },
          }],
        },
      },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_secret' }] } },
    ]);

    const { runBackfill, db } = load();
    const stats = runBackfill({ projectsDir });
    expect(stats.editsInserted).toBe(1);
    expect(stats.errors).toBe(0);

    const rows = db.getDb(PROJECT).getChanges();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.file).toBe(FILE_OUT);
    expect(row.project_path).toBe(PROJECT);
    expect(row.action).toBe('Write');
    expect(row.source).toBe('transcript_backfill');
    expect(row.tool_use_id).toBe('toolu_secret');

    // Secret redacted in both description and diff_text on readback.
    expect(row.diff_text).not.toContain(secret);
    expect(row.diff_text).toContain('[REDACTED_API_KEY]');
    expect(row.description).not.toContain(secret);
  });

  it('multiple transcripts under one projectsDir all land for the same project', () => {
    writeJsonl(path.join(projectsDir, 's1.jsonl'), [
      {
        type: 'assistant', cwd: CWD, timestamp: '2024-05-01T12:00:00Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: FILE_IN, old_string: 'a', new_string: 'b' } }] },
      },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    ]);
    writeJsonl(path.join(projectsDir, 's2.jsonl'), [
      {
        type: 'assistant', cwd: CWD, timestamp: '2024-05-02T12:00:00Z', sessionId: 's2',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: FILE_IN, old_string: 'c', new_string: 'd' } }] },
      },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2' }] } },
    ]);

    const { runBackfill, db } = load();
    const stats = runBackfill({ projectsDir });
    expect(stats.editsInserted).toBe(2);

    const rows = db.getDb(PROJECT).getChanges();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.tool_use_id).sort()).toEqual(['t1', 't2']);
  });
});
