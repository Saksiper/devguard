import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SESSION_END_HOOK = path.resolve(__dirname, '../../src/hooks/session-end.js');

let tmpDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function loadCapture() {
  delete require.cache[require.resolve('../../src/engine/note-capture')];
  delete require.cache[require.resolve('../../src/engine/transcript-parser')];
  delete require.cache[require.resolve('../../src/engine/dg-note')];
  delete require.cache[require.resolve('../../src/engine/sphere-canary')];
  return require('../../src/engine/note-capture');
}

// One-line JSONL transcript whose final assistant reply carries the marker.
function writeTranscript(replyText) {
  const file = path.join(tmpDir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const line = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
  });
  fs.writeFileSync(file, line + '\n', 'utf-8');
  return file;
}

// Run the session-end hook as a real subprocess (each hook call = new process).
function runSessionEnd(input) {
  try {
    execFileSync('node', [SESSION_END_HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0', DEVGUARD_OFFLINE: '1' },
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-session-end-cap-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock window */ }
  }
});

describe('session-end hook — sphere note capture backstop', () => {
  it('SessionEnd input with a DG-NOTE marker captures a note', () => {
    const projectCwd = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectCwd);
    const transcriptPath = writeTranscript(
      'Done. [DG-NOTE ui_ux/filter] Added the date filter to the toolbar.',
    );

    const exit = runSessionEnd({
      session_id: 'sess-se-1',
      transcript_path: transcriptPath,
      cwd: projectCwd,
    });
    expect(exit).toBe(0);

    const db = loadDb();
    const { normalizeProjectPath } = require('../../src/engine/normalize-path');
    const proxy = db.getDb(normalizeProjectPath(projectCwd));
    const notes = proxy.getNotes({ node_id: 'ui_ux/filter' });
    expect(notes).toHaveLength(1);
    expect(notes[0].note_text).toBe('Added the date filter to the toolbar.');
    expect(notes[0].source).toBe('yol2_claude');
    expect(notes[0].session_id).toBe('sess-se-1');
  });

  it('capturing twice on the same transcript writes exactly ONE note (Stop then SessionEnd)', () => {
    const transcriptPath = writeTranscript(
      'Wrapped up. [DG-NOTE security/auth] Kept the token-expiry guard intact.',
    );
    const db = loadDb();
    const proxy = db.getDb('/proj/idem');
    const { captureNoteFromTranscript } = loadCapture();

    // First call = Stop hook fires.
    const id1 = captureNoteFromTranscript(proxy, { transcriptPath, sessionId: 'sess-stop' });
    // Second call = SessionEnd backstop fires on the SAME transcript.
    const id2 = captureNoteFromTranscript(proxy, { transcriptPath, sessionId: 'sess-end' });

    expect(id1).toBeTruthy();
    // Content-based idempotency: head already holds this text → no new insert.
    expect(id2).toBe(id1);

    const notes = proxy.getNotes({ node_id: 'security/auth' });
    expect(notes).toHaveLength(1);
    expect(notes[0].note_text).toBe('Kept the token-expiry guard intact.');
  });
});
