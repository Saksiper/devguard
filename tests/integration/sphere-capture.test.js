import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK_PATH = path.resolve(__dirname, '../../src/hooks/stop.js');
const SE_HOOK_PATH = path.resolve(__dirname, '../../src/hooks/session-end.js');

let dbDir;       // CLAUDE_PLUGIN_DATA (where the SQLite DB lives)
let projectDir;  // the session cwd / project path

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-stop-db-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-stop-proj-'));
});

afterEach(() => {
  for (const dir of [dbDir, projectDir]) {
    if (dir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
});

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  return require('../../src/engine/db');
}

function projectPath() {
  const { normalizeProjectPath } = require('../../src/engine/normalize-path');
  return normalizeProjectPath(projectDir);
}

function writeTranscript(entries) {
  const fp = path.join(projectDir, 'transcript.jsonl');
  fs.writeFileSync(fp, entries.map(e => JSON.stringify(e)).join('\n'));
  return fp;
}

function runStop(inputObj) {
  try {
    execFileSync('node', [HOOK_PATH], {
      input: JSON.stringify(inputObj),
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dbDir,
        DEVGUARD_DEBUG: '0',
        DEVGUARD_OFFLINE: '1',
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: err.stderr || '' };
  }
}

function headNote(nodeId) {
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
  const db = loadDb();
  const proxy = db.getDb(projectPath());
  const head = proxy.getHeadNoteByNode(nodeId);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return head;
}

function notesFor(nodeId) {
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
  const db = loadDb();
  const proxy = db.getDb(projectPath());
  const rows = proxy.getNotes({ node_id: nodeId });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return rows;
}

function runSessionEnd(inputObj) {
  try {
    execFileSync('node', [SE_HOOK_PATH], {
      input: JSON.stringify(inputObj),
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dbDir, DEVGUARD_DEBUG: '0', DEVGUARD_OFFLINE: '1' },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: err.stderr || '' };
  }
}

describe('stop hook — sphere note capture from transcript', () => {
  it('lands a head note when the last assistant reply ends in a DG-NOTE marker', () => {
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: 'add a stop hook' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Implemented the Stop hook. [DG-NOTE logic/stop-hook] Added a Stop hook that captures sphere notes from the final assistant reply.',
          }],
        },
      },
    ]);

    const res = runStop({
      session_id: 'stop-sess-1',
      transcript_path: transcriptPath,
      cwd: projectDir,
    });
    expect(res.ok).toBe(true);

    const head = headNote('logic/stop-hook');
    expect(head).toBeTruthy();
    expect(head.note_text).toBe('Added a Stop hook that captures sphere notes from the final assistant reply.');
    expect(head.source).toBe('yol2_claude');
    expect(head.node_id).toBe('logic/stop-hook');
    expect(head.session_id).toBe('stop-sess-1');
  });

  it('writes no note when the final reply has no marker (non-blocking, exits 0)', () => {
    const transcriptPath = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'All done, nothing worth a sphere note here.' }],
        },
      },
    ]);

    const res = runStop({
      session_id: 'stop-sess-2',
      transcript_path: transcriptPath,
      cwd: projectDir,
    });
    expect(res.ok).toBe(true);
    expect(headNote('logic/stop-hook')).toBeUndefined();
  });

  it('Stop then SessionEnd on the same transcript → exactly one note (idempotent across hooks, non-ASCII)', () => {
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: 'tweak the filter' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Done. [DG-NOTE ui_ux/filter] ﬁxed the ﬁlter for ｆｕｌｌwidth queries',
          }],
        },
      },
    ]);
    const input = { session_id: 'x-sess', transcript_path: transcriptPath, cwd: projectDir };

    expect(runStop(input).ok).toBe(true);
    expect(runSessionEnd(input).ok).toBe(true);

    // HIGH-1: non-ASCII note must not defeat content-idempotency across the two hooks.
    expect(notesFor('ui_ux/filter')).toHaveLength(1);
  });
});

// Run an arbitrary read/write against the same on-disk DB the hooks use.
function withDb(fn) {
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
  const db = loadDb();
  const proxy = db.getDb(projectPath());
  const out = fn(proxy);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return out;
}

function seedSurfaced({ nodeId, sess, text }) {
  return withDb(proxy => {
    const noteId = proxy.insertNote({
      file: nodeId, node_id: nodeId, source: 'yol2_claude', confidence_level: 3,
      note_text: text || 'prior-' + nodeId, session_id: 'earlier-session',
    });
    proxy.insertNoteEvent({ note_id: noteId, session_id: sess, event_type: 'surfaced' });
    return noteId;
  });
}

function complianceEvents(noteId) {
  return withDb(proxy => proxy.getNoteEvents({ note_id: noteId })
    .filter(e => ['complied', 'ignored', 'superseded'].includes(e.event_type)));
}

describe('stop/session-end hooks — ack compliance harvest', () => {
  it('Stop harvests the turn-end ack block: surfaced note complied + new note layered', () => {
    const priorId = seedSurfaced({ nodeId: 'ui_ux/filter', sess: 'ack-sess-1', text: 'v1 decision' });
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: 'extend the filter' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Extended the filter.\n[DG-CONTINUE ui_ux/filter] kept the v1 decision and extended it.\n[DG-NOTE ui_ux/filter] added range filtering on top of v1.',
          }],
        },
      },
    ]);

    expect(runStop({ session_id: 'ack-sess-1', transcript_path: transcriptPath, cwd: projectDir }).ok).toBe(true);

    const events = complianceEvents(priorId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('complied');
    expect(JSON.parse(events[0].payload).via).toBe('stop_ack');
    expect(headNote('ui_ux/filter').note_text).toBe('added range filtering on top of v1.');
  });

  it('SessionEnd finalizes an unacked surfaced note as ignored', () => {
    const priorId = seedSurfaced({ nodeId: 'security/auth', sess: 'ack-sess-2' });
    const transcriptPath = writeTranscript([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Answered a question, no ack, no note.' }] },
      },
    ]);

    expect(runSessionEnd({ session_id: 'ack-sess-2', transcript_path: transcriptPath, cwd: projectDir }).ok).toBe(true);

    const events = complianceEvents(priorId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('ignored');
    expect(JSON.parse(events[0].payload).via).toBe('session_end_finalize');
  });

  it('Stop then SessionEnd on the same acked transcript → exactly ONE compliance event', () => {
    const priorId = seedSurfaced({ nodeId: 'ui_ux/search', sess: 'ack-sess-3', text: 'v1 search decision' });
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: 'extend search' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Done.\n[DG-CONTINUE ui_ux/search] kept the v1 search decision.\n[DG-NOTE ui_ux/search] added fuzzy matching on top of v1.',
          }],
        },
      },
    ]);
    const input = { session_id: 'ack-sess-3', transcript_path: transcriptPath, cwd: projectDir };

    expect(runStop(input).ok).toBe(true);
    expect(runSessionEnd(input).ok).toBe(true);

    const events = complianceEvents(priorId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('complied');
  });
});
