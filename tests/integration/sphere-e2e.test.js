import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

// End-to-end "tracer bullet" proof: the read gate (user-prompt-submit) and the
// capture hook (stop) wired through a shared DB across two touches of the SAME
// feature. This is the ONE thing the tracer bullet proves beyond the spike:
// on the second touch the prior head is correctly superseded and a single head
// is kept — in real hook processes, not a fake transcript.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const UPS = path.resolve(__dirname, '../../src/hooks/user-prompt-submit.js');
const STOP = path.resolve(__dirname, '../../src/hooks/stop.js');

let dbDir, projectDir;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-e2e-db-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-e2e-proj-'));
});
afterEach(() => {
  for (const d of [dbDir, projectDir]) {
    if (d && fs.existsSync(d)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ } }
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
function ensureSession(sessionId) {
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
  const db = loadDb();
  db.getDb(projectPath()).insertSession(sessionId);
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
}
function notesFor(nodeId) {
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
  const db = loadDb();
  const rows = db.getDb(projectPath()).getNotes({ node_id: nodeId });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return rows;
}
function surfacedEvents() {
  process.env.CLAUDE_PLUGIN_DATA = dbDir;
  const db = loadDb();
  const rows = db.getDb(projectPath()).getNoteEvents({ event_type: 'surfaced' });
  db.closeDb();
  delete require.cache[require.resolve('../../src/engine/db')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  return rows;
}
function run(hookPath, input) {
  const stdout = execFileSync('node', [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dbDir, DEVGUARD_DEBUG: '0', DEVGUARD_OFFLINE: '1' },
  });
  return stdout;
}
function writeTranscript(markerText) {
  const fp = path.join(projectDir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(fp, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'work on the filter' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: markerText }] } }),
  ].join('\n') + '\n');
  return fp;
}

describe('sphere e2e — two-touch read/write/layer chain', () => {
  it('touch1: no note → instruct; capture; touch2: surface prior → new marker supersedes, single head', () => {
    ensureSession('e2e-sess');

    // --- Touch 1: prompt names the feature, no note yet → read gate instructs ---
    const ups1 = JSON.parse(run(UPS, { cwd: projectDir, session_id: 'e2e-sess', prompt: 'add a filter to the list' }));
    const ctx1 = ups1.hookSpecificOutput?.additionalContext || '';
    expect(ctx1).toContain('[DG-NOTE ui_ux/filter]');
    expect(ctx1.toLowerCase()).toContain('no prior note');

    // --- Claude works and leaves a marker → Stop captures it ---
    run(STOP, { session_id: 'e2e-sess', transcript_path: writeTranscript('Implemented it. [DG-NOTE ui_ux/filter] made the filter case-insensitive'), cwd: projectDir });
    const after1 = notesFor('ui_ux/filter');
    expect(after1).toHaveLength(1);
    expect(after1[0].note_text).toBe('made the filter case-insensitive');
    const firstId = after1[0].id;

    // A concurrent headless `claude -p` inserts a NEWER 'sessions' row mid-turn;
    // getLatestSession() would return it, so the g2 surfaced-event assertion below
    // genuinely discriminates the fix from the buggy (getLatestSession) version.
    ensureSession('headless-newer-decoy');

    // --- Touch 2 (later): same feature, head now exists → read gate surfaces it ---
    const ups2 = JSON.parse(run(UPS, { cwd: projectDir, session_id: 'e2e-sess', prompt: 'change the filter behavior' }));
    const ctx2 = ups2.hookSpecificOutput?.additionalContext || '';
    expect(ctx2).toContain('made the filter case-insensitive'); // prior note surfaced
    expect(ctx2.toLowerCase()).toContain('respect');           // layering instruction

    // The surfaced note_event is attributed to the submitting session, not the
    // newest 'sessions' row (work item g2).
    const surfaced = surfacedEvents();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].session_id).toBe('e2e-sess');

    // --- Claude layers a new marker → Stop supersedes the old head ---
    run(STOP, { session_id: 'e2e-sess', transcript_path: writeTranscript('Extended it. [DG-NOTE ui_ux/filter] added city-name matching, kept case-insensitivity'), cwd: projectDir });

    const all = notesFor('ui_ux/filter');
    expect(all).toHaveLength(2);                                 // history preserved
    const heads = all.filter(r => r.superseded_by === null);
    expect(heads).toHaveLength(1);                               // exactly one head (the invariant)
    expect(heads[0].note_text).toBe('added city-name matching, kept case-insensitivity');
    expect(all.find(r => r.id === firstId).superseded_by).toBe(heads[0].id); // old → new
  });
});
