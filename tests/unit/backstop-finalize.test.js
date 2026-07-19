import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-backstop-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows WAL lock */ }
  }
});

function freshDb(projectPath) {
  return loadDb().getDb(projectPath || '/test/project');
}

// Same underlying connection the proxy uses (openDb returns the singleton), so
// backdating writes are visible immediately with no second-connection locking.
function conn() {
  return require('../../src/engine/db').openDb();
}

function seedSurfaced(proxy, { nodeId, sess, sourceFile }) {
  const noteId = proxy.insertNote({
    file: nodeId, node_id: nodeId, source: 'yol2_claude', confidence_level: 3,
    note_text: 'note-' + nodeId, session_id: sess, source_file: sourceFile,
  });
  proxy.insertNoteEvent({ note_id: noteId, session_id: sess, event_type: 'surfaced' });
  return noteId;
}

// Backdate ALL of a session's note_events.ts (sqlite format) to `expr` hours/mins
// ago. The surfaced note_event is stamped at now on insert, so a session only looks
// stale once its own events are aged.
function backdateSession(sessionId, expr) {
  const c = conn();
  const ts = c.prepare(`SELECT datetime('now', ?) AS t`).get(expr).t;
  c.prepare(`UPDATE note_events SET ts = ? WHERE session_id = ?`).run(ts, sessionId);
}

function backdateNullSession(expr) {
  const c = conn();
  const ts = c.prepare(`SELECT datetime('now', ?) AS t`).get(expr).t;
  c.prepare(`UPDATE note_events SET ts = ? WHERE session_id IS NULL`).run(ts);
}

function isoAgo(expr) {
  const c = conn();
  return c.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS t`).get(expr).t;
}

describe('db.js — finalizeStaleSessions (SessionStart orphan backstop)', () => {
  it('finalizes a stale orphan session surfaced note as lapsed', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'orphan', sourceFile: 'x.js' });
    backdateSession('orphan', '-8 hours');

    const res = proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });
    expect(res.sessions).toBe(1);
    expect(res.emitted).toBe(1);

    const ev = proxy.getNoteEvents({ note_id: noteId, event_type: 'lapsed' });
    expect(ev).toHaveLength(1);
    const payload = JSON.parse(ev[0].payload);
    expect(payload.via).toBe('backstop_finalize');
    expect(payload.outcome).toBe('no_ack');
    expect(payload.node_id).toBe('ui_ux/filter');
    // lapsed, NOT ignored — a dead session had no chance to ack
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'ignored' })).toHaveLength(0);
  });

  it('does NOT finalize a session active within the threshold (parallel-live guard)', () => {
    const proxy = freshDb();
    seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'live' });
    backdateSession('live', '-5 minutes');

    const res = proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });
    expect(res.emitted).toBe(0);
  });

  it('parses ISO-8601 changes.timestamp so a recent orphan stays active (BLOCKER-1)', () => {
    const proxy = freshDb();
    seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'orphan', sourceFile: 'x.js' });
    // Age the surfaced note_event well past the threshold...
    backdateSession('orphan', '-10 hours');
    // ...but record RECENT activity as an ISO-8601 string (the backfill format).
    // Raw-string MAX or a datetime() that NULLed the ISO row would fall back to the
    // 10h-old note_event and wrongly finalize. datetime() must parse the ISO as recent.
    proxy.insertChange({ session_id: 'orphan', file: 'x.js', action: 'Edit', timestamp: isoAgo('-2 hours') });

    const res = proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });
    expect(res.emitted).toBe(0);
  });

  it('finalizes when the only activity is an OLD ISO-8601 timestamp', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'orphan', sourceFile: 'x.js' });
    backdateSession('orphan', '-9 hours');
    proxy.insertChange({ session_id: 'orphan', file: 'x.js', action: 'Edit', timestamp: isoAgo('-8 hours') });

    const res = proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });
    expect(res.emitted).toBe(1);
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'lapsed' })).toHaveLength(1);
  });

  it('never finalizes the current session or NULL-session surfaced notes', () => {
    const proxy = freshDb();
    const curNote = seedSurfaced(proxy, { nodeId: 'ui_ux/a', sess: 'current' });
    backdateSession('current', '-8 hours');
    const nullNote = proxy.insertNote({
      file: 'ui_ux/b', node_id: 'ui_ux/b', source: 'yol2_claude', confidence_level: 3, note_text: 'x',
    });
    proxy.insertNoteEvent({ note_id: nullNote, session_id: null, event_type: 'surfaced' });
    backdateNullSession('-8 hours');

    const res = proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });
    expect(res.emitted).toBe(0);
    expect(proxy.getNoteEvents({ note_id: curNote, event_type: 'lapsed' })).toHaveLength(0);
    expect(proxy.getNoteEvents({ note_id: nullNote, event_type: 'lapsed' })).toHaveLength(0);
  });

  it('is idempotent — a second run emits nothing (lapsed is in the dedup set)', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'orphan' });
    backdateSession('orphan', '-8 hours');

    expect(proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 }).emitted).toBe(1);
    // Second run: the note now has a 'lapsed' event → excluded by the UNTRACKED dedup.
    expect(proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 }).emitted).toBe(0);
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'lapsed' })).toHaveLength(1);
  });

  it('marks superseded (not lapsed) when the node head has advanced', () => {
    const proxy = freshDb();
    const oldNote = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'orphan' });
    backdateSession('orphan', '-8 hours');
    // A newer note on the same node (later id) becomes the head → the surfaced note is superseded.
    proxy.insertNote({
      file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude', confidence_level: 3,
      note_text: 'newer head', session_id: 'other',
    });

    proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });
    expect(proxy.getNoteEvents({ note_id: oldNote, event_type: 'superseded' })).toHaveLength(1);
    expect(proxy.getNoteEvents({ note_id: oldNote, event_type: 'lapsed' })).toHaveLength(0);
  });

  it('returns zero for missing or invalid staleAfterHours', () => {
    const proxy = freshDb();
    seedSurfaced(proxy, { nodeId: 'ui_ux/a', sess: 'orphan' });
    backdateSession('orphan', '-8 hours');
    expect(proxy.finalizeStaleSessions({ excludeSessionId: 'current' }).emitted).toBe(0);
    expect(proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 0 }).emitted).toBe(0);
    expect(proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: -3 }).emitted).toBe(0);
  });

  it('fails closed when the threshold is so large datetime() yields no cutoff', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 'orphan' });
    backdateSession('orphan', '-8 hours');
    // Absurd value → datetime('now','-1e21 hours') is NULL. Must NOT fail open and
    // finalize the (or any) session — staleness is the only live-terminal guard.
    const res = proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 1e21 });
    expect(res.emitted).toBe(0);
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'lapsed' })).toHaveLength(0);
  });
});

describe('db.js — clean-close finalize unchanged (refactor safety)', () => {
  it('finalizeNoteCompliance still emits ignored via session_end_finalize', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const emitted = proxy.finalizeNoteCompliance('s1');
    expect(emitted).toBe(1);
    const ev = proxy.getNoteEvents({ note_id: noteId, event_type: 'ignored' });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload).via).toBe('session_end_finalize');
    expect(JSON.parse(ev[0].payload).outcome).toBe('no_ack');
  });
});

describe('db.js — getNoteComplianceStats lapsed bucket', () => {
  it('counts lapsed separately and excludes it from the compliance denominator', () => {
    const proxy = freshDb();
    seedSurfaced(proxy, { nodeId: 'ui_ux/a', sess: 'orphan' });
    backdateSession('orphan', '-8 hours');
    proxy.finalizeStaleSessions({ excludeSessionId: 'current', staleAfterHours: 6 });

    seedSurfaced(proxy, { nodeId: 'ui_ux/b', sess: 's2' });
    proxy.ackNoteCompliance('s2', { outcome: 'dg_continue', nodeId: 'ui_ux/b' });

    const stats = proxy.getNoteComplianceStats();
    expect(stats.lapsed).toBe(1);
    expect(stats.complied).toBe(1);
    expect(stats.ignored).toBe(0);
    // compliance = complied / (complied + ignored) = 1/1; lapsed is NOT in the denominator.
    expect(stats.compliance).toBe(1);
  });
});
