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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-db-notes-test-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try {
    const db = require('../../src/engine/db');
    db.closeDb();
  } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  if (tmpDir && fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: WAL/SHM files may still be locked briefly
    }
  }
});

function freshDb(projectPath) {
  const db = loadDb();
  return db.getDb(projectPath || '/test/project');
}

describe('db.js — notes (V13)', () => {
  it('inserts a note with all required fields and returns id', () => {
    const proxy = freshDb();
    const id = proxy.insertNote({
      file: 'src/auth.js',
      source: 'yol0_heuristic',
      confidence_level: 1,
      note_text: 'try/catch must stay — silent fail boundary',
      lines_start: 10,
      lines_end: 15,
      node_id: 'src/auth.js:validateToken',
      trigger_data: { matched_pattern: 'try_catch_removed', edit_id: 42 },
    });
    expect(id).toBeGreaterThan(0);

    const rows = proxy.getNotes();
    expect(rows).toHaveLength(1);
    expect(rows[0].file).toBe('src/auth.js');
    expect(rows[0].source).toBe('yol0_heuristic');
    expect(rows[0].confidence_level).toBe(1);
    expect(rows[0].note_text).toBe('try/catch must stay — silent fail boundary');
    expect(rows[0].lines_start).toBe(10);
    expect(rows[0].lines_end).toBe(15);
    expect(rows[0].node_id).toBe('src/auth.js:validateToken');
    expect(JSON.parse(rows[0].trigger_data)).toEqual({ matched_pattern: 'try_catch_removed', edit_id: 42 });
    expect(rows[0].project_path).toBe('/test/project');
  });

  it('rejects insertNote when NOT NULL fields are missing', () => {
    const proxy = freshDb();
    // file missing
    expect(() => proxy.insertNote({ source: 'yol0_heuristic', confidence_level: 1, note_text: 'x' })).toThrow();
    // source missing
    expect(() => proxy.insertNote({ file: 'a.js', confidence_level: 1, note_text: 'x' })).toThrow();
    // confidence_level missing
    expect(() => proxy.insertNote({ file: 'a.js', source: 'yol0_heuristic', note_text: 'x' })).toThrow();
    // note_text missing
    expect(() => proxy.insertNote({ file: 'a.js', source: 'yol0_heuristic', confidence_level: 1 })).toThrow();
  });

  it('getNotes filters by file and source', () => {
    const proxy = freshDb();
    proxy.insertNote({ file: 'a.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'n1' });
    proxy.insertNote({ file: 'a.js', source: 'yol2_claude_marker', confidence_level: 2, note_text: 'n2' });
    proxy.insertNote({ file: 'b.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'n3' });

    expect(proxy.getNotes({ file: 'a.js' })).toHaveLength(2);
    expect(proxy.getNotes({ source: 'yol0_heuristic' })).toHaveLength(2);
    expect(proxy.getNotes({ file: 'a.js', source: 'yol2_claude_marker' })).toHaveLength(1);
    expect(proxy.getNotes({ file: 'a.js', source: 'yol2_claude_marker' })[0].note_text).toBe('n2');
  });

  it('getNotes filters by node_id prefix', () => {
    const proxy = freshDb();
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n1', node_id: 'ui_ux/filter' });
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n2', node_id: 'ui_ux/sort' });
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n3', node_id: 'security/auth' });

    const uiNotes = proxy.getNotes({ node_id_prefix: 'ui_ux/' });
    expect(uiNotes).toHaveLength(2);
    expect(uiNotes.map(n => n.note_text).sort()).toEqual(['n1', 'n2']);
  });

  it('escapes LIKE wildcards in node_id prefix so "_" and "%" are literal', () => {
    const proxy = freshDb();
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'literal-underscore', node_id: 'ui_ux/filter' });
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'single-char-node', node_id: 'uiXux/filter' });

    // Without ESCAPE handling, '_' is a SQL LIKE wildcard matching any single char —
    // "ui_ux/" would wrongly also match "uiXux/". Prefix search must treat it literally.
    const rows = proxy.getNotes({ node_id_prefix: 'ui_ux/' });
    expect(rows).toHaveLength(1);
    expect(rows[0].note_text).toBe('literal-underscore');
  });

  it('multi-tenant: notes scoped to project_path', () => {
    const db = loadDb();
    const projA = db.getDb('/proj/a');
    const projB = db.getDb('/proj/b');
    projA.insertNote({ file: 'x.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'A-only' });
    projB.insertNote({ file: 'x.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'B-only' });

    const aRows = projA.getNotes();
    const bRows = projB.getNotes();
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].note_text).toBe('A-only');
    expect(bRows[0].note_text).toBe('B-only');
  });

  it('sanitizes note_text and trigger_data JSON', () => {
    const proxy = freshDb();
    // Sanitize patterns redact known secret formats. Use a GitHub PAT and a
    // generic sk- token that match existing SANITIZE_PATTERNS in sanitize.js.
    const githubPat = 'ghp_' + 'a'.repeat(36);
    const skKey = 'sk-' + 'a'.repeat(24);
    proxy.insertNote({
      file: 'a.js',
      source: 'yol0_heuristic',
      confidence_level: 1,
      note_text: `leaked ${githubPat} in comment`,
      trigger_data: { secret_value: skKey },
    });
    const row = proxy.getNotes()[0];
    expect(row.note_text).not.toContain(githubPat);
    expect(row.note_text).toContain('[REDACTED_GITHUB_PAT]');
    expect(row.trigger_data).not.toContain(skKey);
    expect(row.trigger_data).toContain('[REDACTED_API_KEY]');
  });
});

describe('db.js — note_events (V13)', () => {
  it('inserts a note_event linked to a note', () => {
    const proxy = freshDb();
    const noteId = proxy.insertNote({
      file: 'a.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'n1',
    });
    const eventId = proxy.insertNoteEvent({
      note_id: noteId,
      event_type: 'surfaced',
      session_id: 'sess-xyz',
      payload: { surface_target: 'pre-edit-warn' },
    });
    expect(eventId).toBeGreaterThan(0);
    const events = proxy.getNoteEvents({ note_id: noteId });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('surfaced');
    expect(events[0].session_id).toBe('sess-xyz');
    expect(JSON.parse(events[0].payload)).toEqual({ surface_target: 'pre-edit-warn' });
  });

  it('getNoteEvents filters by note_id and event_type', () => {
    const proxy = freshDb();
    const n1 = proxy.insertNote({ file: 'a.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'n1' });
    const n2 = proxy.insertNote({ file: 'b.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'n2' });
    proxy.insertNoteEvent({ note_id: n1, event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n1, event_type: 'dg_pivot' });
    proxy.insertNoteEvent({ note_id: n2, event_type: 'surfaced' });

    expect(proxy.getNoteEvents({ note_id: n1 })).toHaveLength(2);
    expect(proxy.getNoteEvents({ event_type: 'surfaced' })).toHaveLength(2);
    expect(proxy.getNoteEvents({ note_id: n1, event_type: 'dg_pivot' })).toHaveLength(1);
  });

  it('migration V13 is idempotent (CREATE TABLE IF NOT EXISTS)', () => {
    const db = loadDb();
    const proxy = db.getDb('/test/project');
    proxy.insertNote({ file: 'a.js', source: 'yol0_heuristic', confidence_level: 1, note_text: 'pre-close' });
    db.closeDb();
    // Re-open: migrations skip already-applied versions; CREATE TABLE IF NOT
    // EXISTS would still be safe even without that guard.
    db.openDb();
    const proxy2 = db.getDb('/test/project');
    expect(proxy2.getNotes()).toHaveLength(1);
    expect(proxy2.getNotes()[0].note_text).toBe('pre-close');
  });
});

describe('db.js — hasSurfacedNodeInSession (per-session surface cooldown)', () => {
  it('true only for the surfaced (node, session) pair', () => {
    const proxy = freshDb();
    const noteId = proxy.insertNote({
      file: 'a.js', source: 'yol2_claude', confidence_level: 3, note_text: 'n1', node_id: 'ui_ux/filter',
    });
    proxy.insertNoteEvent({ note_id: noteId, session_id: 's1', event_type: 'surfaced', payload: { node_id: 'ui_ux/filter' } });

    expect(proxy.hasSurfacedNodeInSession('ui_ux/filter', 's1')).toBe(true);
    expect(proxy.hasSurfacedNodeInSession('ui_ux/filter', 's2')).toBe(false);
    expect(proxy.hasSurfacedNodeInSession('ui_ux/search', 's1')).toBe(false);
  });

  it('node-keyed, not note-keyed: a surface on an older layer of the node still counts', () => {
    // Each ack advances the head note id; a note-keyed check would re-surface every turn.
    const proxy = freshDb();
    const oldId = proxy.insertNote({
      file: 'a.js', source: 'yol2_claude', confidence_level: 3, note_text: 'old layer', node_id: 'ui_ux/filter',
    });
    proxy.insertNoteEvent({ note_id: oldId, session_id: 's1', event_type: 'surfaced', payload: { node_id: 'ui_ux/filter' } });
    proxy.insertNote({
      file: 'a.js', source: 'yol2_claude', confidence_level: 3, note_text: 'new head', node_id: 'ui_ux/filter',
    });

    expect(proxy.hasSurfacedNodeInSession('ui_ux/filter', 's1')).toBe(true);
  });
});

describe('db.js — notes node_id (V13 head/supersede)', () => {
  it('getNotes filters by node_id', () => {
    const proxy = freshDb();
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n1', node_id: 'a.js:foo' });
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n2', node_id: 'a.js:foo' });
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n3', node_id: 'a.js:bar' });

    expect(proxy.getNotes({ node_id: 'a.js:foo' })).toHaveLength(2);
    expect(proxy.getNotes({ node_id: 'a.js:bar' })).toHaveLength(1);
    expect(proxy.getNotes({ node_id: 'a.js:bar' })[0].note_text).toBe('n3');
  });

  it('getNotes node_id combines with existing filters and does not break default', () => {
    const proxy = freshDb();
    proxy.insertNote({ file: 'a.js', source: 'x', confidence_level: 1, note_text: 'n1', node_id: 'a.js:foo' });
    proxy.insertNote({ file: 'b.js', source: 'x', confidence_level: 1, note_text: 'n2', node_id: 'a.js:foo' });
    // no node_id filter → both visible
    expect(proxy.getNotes()).toHaveLength(2);
    // node_id + file together
    expect(proxy.getNotes({ node_id: 'a.js:foo', file: 'b.js' })).toHaveLength(1);
    expect(proxy.getNotes({ node_id: 'a.js:foo', file: 'b.js' })[0].note_text).toBe('n2');
  });

  it('getHeadNoteByNode returns newest head by id DESC tiebreaker', () => {
    const proxy = freshDb();
    // All inserted in same second; created_at would tie, so id DESC must decide.
    const id1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'first', node_id: 'a.js:foo' });
    const id2 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'second', node_id: 'a.js:foo' });
    expect(id2).toBeGreaterThan(id1);

    const head = proxy.getHeadNoteByNode('a.js:foo');
    expect(head).toBeDefined();
    expect(head.id).toBe(id2);
    expect(head.note_text).toBe('second');
  });

  it('getHeadNoteByNode ignores superseded notes', () => {
    const proxy = freshDb();
    const id1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'old', node_id: 'a.js:foo' });
    const id2 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'new', node_id: 'a.js:foo' });
    proxy.supersedePriorHead('a.js:foo', id2);

    const head = proxy.getHeadNoteByNode('a.js:foo');
    expect(head.id).toBe(id2);
    // id1 must now be superseded
    const all = proxy.getNotes({ node_id: 'a.js:foo' });
    const old = all.find(r => r.id === id1);
    expect(old.superseded_by).toBe(id2);
  });

  it('getHeadNoteByNode returns undefined when no head exists', () => {
    const proxy = freshDb();
    expect(proxy.getHeadNoteByNode('nope')).toBeUndefined();
  });

  it('supersedePriorHead enforces single-head invariant', () => {
    const proxy = freshDb();
    // Three competing heads (none superseded yet) under the same node.
    const id1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'h1', node_id: 'a.js:foo' });
    const id2 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'h2', node_id: 'a.js:foo' });
    const id3 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'h3', node_id: 'a.js:foo' });

    proxy.supersedePriorHead('a.js:foo', id3);

    // After: exactly one head, and it is id3.
    const heads = proxy.getNotes({ node_id: 'a.js:foo' }).filter(r => r.superseded_by === null);
    expect(heads).toHaveLength(1);
    expect(heads[0].id).toBe(id3);
    expect(proxy.getHeadNoteByNode('a.js:foo').id).toBe(id3);

    // The other two point at id3.
    const all = proxy.getNotes({ node_id: 'a.js:foo' });
    expect(all.find(r => r.id === id1).superseded_by).toBe(id3);
    expect(all.find(r => r.id === id2).superseded_by).toBe(id3);
  });

  it('supersedePriorHead is a no-op when newId is the only head', () => {
    const proxy = freshDb();
    const id1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'h1', node_id: 'a.js:foo' });
    proxy.supersedePriorHead('a.js:foo', id1);
    const head = proxy.getHeadNoteByNode('a.js:foo');
    expect(head.id).toBe(id1);
    expect(head.superseded_by).toBeNull();
  });

  it('supersedePriorHead with a non-head newId is a no-op (no orphaning)', () => {
    const proxy = freshDb();
    const id1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'h1', node_id: 'a.js:foo' });
    proxy.supersedePriorHead('a.js:foo', 999999); // bogus newId, not a head of this node
    const head = proxy.getHeadNoteByNode('a.js:foo');
    expect(head).toBeDefined();
    expect(head.id).toBe(id1); // existing head preserved; node not left headless
  });

  it('mergeNodes moves notes and reconciles to a single head for target', () => {
    const proxy = freshDb();
    // fromNode has two notes, toNode has one head already.
    const f1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'from-1', node_id: 'a.js:foo' });
    const f2 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'from-2', node_id: 'a.js:foo' });
    const t1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'to-1', node_id: 'a.js:bar' });

    proxy.mergeNodes('a.js:foo', 'a.js:bar');

    // No notes remain under the old node.
    expect(proxy.getNotes({ node_id: 'a.js:foo' })).toHaveLength(0);
    // All three now under target node.
    const merged = proxy.getNotes({ node_id: 'a.js:bar' });
    expect(merged).toHaveLength(3);
    // Exactly one head, the newest by id (f2).
    const heads = merged.filter(r => r.superseded_by === null);
    expect(heads).toHaveLength(1);
    const newest = Math.max(f1, f2, t1);
    expect(heads[0].id).toBe(newest);
    expect(proxy.getHeadNoteByNode('a.js:bar').id).toBe(newest);
  });

  it('mergeNodes is a no-op when fromNode has no notes', () => {
    const proxy = freshDb();
    const t1 = proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'to-1', node_id: 'a.js:bar' });
    proxy.mergeNodes('a.js:empty', 'a.js:bar');
    expect(proxy.getHeadNoteByNode('a.js:bar').id).toBe(t1);
    expect(proxy.getNotes({ node_id: 'a.js:bar' })).toHaveLength(1);
  });
});

describe('db.js — insertNote related_change_id (S3.3.4a)', () => {
  it('persists related_change_id when provided', () => {
    const proxy = freshDb();
    const id = proxy.insertNote({
      file: 'a.js', source: 's', confidence_level: 1, note_text: 'n', node_id: 'a.js:foo',
      related_change_id: 42,
    });
    const row = proxy.getNotes()[0];
    expect(row.id).toBe(id);
    expect(row.related_change_id).toBe(42);
  });

  it('defaults related_change_id to null when omitted (backward compatible)', () => {
    const proxy = freshDb();
    proxy.insertNote({ file: 'a.js', source: 's', confidence_level: 1, note_text: 'n' });
    expect(proxy.getNotes()[0].related_change_id).toBeNull();
  });
});

// Seed a surfaced note_event for a note under nodeId in session sess.
function seedSurfaced(proxy, { nodeId, sess, text, sourceFile }) {
  const noteId = proxy.insertNote({
    file: nodeId, node_id: nodeId, source: 'yol2_claude', confidence_level: 3,
    note_text: text || 'note-' + nodeId, session_id: sess,
    source_file: sourceFile,
  });
  proxy.insertNoteEvent({ note_id: noteId, session_id: sess, event_type: 'surfaced' });
  return noteId;
}

const DECIDED = ['complied', 'ignored', 'superseded'];
function decidedEvents(proxy, noteId) {
  return proxy.getNoteEvents({ note_id: noteId }).filter(e => DECIDED.includes(e.event_type));
}

describe('db.js — ackNoteCompliance (session+ack anchor)', () => {
  it('node-echoed ack marks the surfaced note complied with a stop_ack payload', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const res = proxy.ackNoteCompliance('s1', {
      outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'kept the tokenized search',
    });
    expect(res.emitted).toBe(1);
    const ev = proxy.getNoteEvents({ note_id: noteId, event_type: 'complied' });
    expect(ev).toHaveLength(1);
    expect(ev[0].change_id).toBeNull();
    const payload = JSON.parse(ev[0].payload);
    expect(payload.via).toBe('stop_ack');
    expect(payload.echo).toBe(true);
    expect(payload.outcome).toBe('dg_continue');
    expect(payload.node_id).toBe('ui_ux/filter');
    expect(payload.reason).toBe('kept the tokenized search');
  });

  it('classifies ALL untracked surfaced notes on the acked node', () => {
    const proxy = freshDb();
    const n1 = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1', text: 'v1' });
    const n2 = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1', text: 'v2' });
    const res = proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });
    expect(res.emitted).toBe(2);
    expect(proxy.getNoteEvents({ note_id: n1, event_type: 'complied' })).toHaveLength(1);
    expect(proxy.getNoteEvents({ note_id: n2, event_type: 'complied' })).toHaveLength(1);
  });

  it('echoed node with no surfaced candidate writes nothing (unmatched)', () => {
    const proxy = freshDb();
    const other = seedSurfaced(proxy, { nodeId: 'ui_ux/search', sess: 's1' });
    const res = proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'x' });
    expect(res.emitted).toBe(0);
    expect(res.reasonCode).toBe('unmatched');
    expect(decidedEvents(proxy, other)).toHaveLength(0);
  });

  it('echo-less ack never scores compliance, even in a single-node session (cycle-warn cross-talk guard)', () => {
    // The pre-edit cycle-warn directive asks for a bare [DG-CONTINUE] at reply
    // START; crediting a bare tag to the session's only surfaced note would count
    // a cycle answer as sphere compliance. Echo is REQUIRED.
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const res = proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: null, reason: 'ok' });
    expect(res.emitted).toBe(0);
    expect(res.reasonCode).toBe('echoless');
    expect(decidedEvents(proxy, noteId)).toHaveLength(0);
  });

  it('still credits complied when the head has already advanced (read→comply→layer)', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const newId = proxy.insertNote({
      file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude',
      confidence_level: 3, note_text: 'v2 layered after complying', session_id: 's1',
    });
    proxy.supersedePriorHead('ui_ux/filter', newId);
    const res = proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });
    expect(res.emitted).toBe(1);
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'complied' })).toHaveLength(1);
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'superseded' })).toHaveLength(0);
  });

  it('dedup: a second ack for the same note is a no-op', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });
    const second = proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'again' });
    expect(second.emitted).toBe(0);
    expect(decidedEvents(proxy, noteId)).toHaveLength(1);
  });

  it('records same_file true/false from the session changes, null without source_file', () => {
    const proxy = freshDb();
    const nTrue = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1', sourceFile: 'src/a.js' });
    proxy.insertChange({ session_id: 's1', file: 'src/a.js', action: 'Edit' });
    proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });
    expect(JSON.parse(proxy.getNoteEvents({ note_id: nTrue, event_type: 'complied' })[0].payload).same_file).toBe(true);

    const nFalse = seedSurfaced(proxy, { nodeId: 'ui_ux/search', sess: 's2', sourceFile: 'src/b.js' });
    proxy.insertChange({ session_id: 's2', file: 'src/other.js', action: 'Edit' });
    proxy.ackNoteCompliance('s2', { outcome: 'dg_continue', nodeId: 'ui_ux/search', reason: 'ok' });
    expect(JSON.parse(proxy.getNoteEvents({ note_id: nFalse, event_type: 'complied' })[0].payload).same_file).toBe(false);

    const nNull = seedSurfaced(proxy, { nodeId: 'security/auth', sess: 's3' });
    proxy.ackNoteCompliance('s3', { outcome: 'dg_continue', nodeId: 'security/auth', reason: 'ok' });
    expect(JSON.parse(proxy.getNoteEvents({ note_id: nNull, event_type: 'complied' })[0].payload).same_file).toBeNull();
  });

  it('a PIVOT ack still counts as complied with the outcome preserved in the payload', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    proxy.ackNoteCompliance('s1', { outcome: 'dg_pivot', nodeId: 'ui_ux/filter', reason: 'diverged deliberately' });
    const ev = proxy.getNoteEvents({ note_id: noteId, event_type: 'complied' });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload).outcome).toBe('dg_pivot');
  });

  it('multi-tenant: an ack in project B never touches project A', () => {
    const db = loadDb();
    const projA = db.getDb('/proj/a');
    const projB = db.getDb('/proj/b');
    const noteId = seedSurfaced(projA, { nodeId: 'ui_ux/filter', sess: 's1' });
    const res = projB.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'x' });
    expect(res.emitted).toBe(0);
    expect(decidedEvents(projA, noteId)).toHaveLength(0);
  });
});

describe('db.js — getNoteComplianceStats re-surface dilution guard', () => {
  it('re-surfacing the same note in the same session does not dilute compliance_of_surfaced', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    // Every later prompt in the session re-surfaces the head note.
    proxy.insertNoteEvent({ note_id: noteId, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: noteId, session_id: 's1', event_type: 'surfaced' });
    proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });

    const s = proxy.getNoteComplianceStats();
    // One measurement opportunity (note × session), fully complied — not 1/3.
    expect(s.surfaced).toBe(1);
    expect(s.complied).toBe(1);
    expect(s.compliance_of_surfaced).toBeCloseTo(1.0, 6);
  });

  it('the same note surfaced in two sessions counts as two opportunities', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    proxy.insertNoteEvent({ note_id: noteId, session_id: 's2', event_type: 'surfaced' });
    proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });
    proxy.finalizeNoteCompliance('s2');

    const s = proxy.getNoteComplianceStats();
    expect(s.surfaced).toBe(2);
    expect(s.complied).toBe(1);
    expect(s.ignored).toBe(1);
    expect(s.compliance_of_surfaced).toBeCloseTo(0.5, 6);
  });
});

describe('db.js — finalizeNoteCompliance (SessionEnd)', () => {
  it('marks an unacked surfaced note ignored with a finalize payload', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const emitted = proxy.finalizeNoteCompliance('s1');
    expect(emitted).toBe(1);
    const ev = proxy.getNoteEvents({ note_id: noteId, event_type: 'ignored' });
    expect(ev).toHaveLength(1);
    const payload = JSON.parse(ev[0].payload);
    expect(payload.via).toBe('session_end_finalize');
    expect(payload.outcome).toBe('no_ack');
  });

  it('marks an unacked note superseded when the head has advanced', () => {
    const proxy = freshDb();
    const noteId = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const newId = proxy.insertNote({
      file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude',
      confidence_level: 3, note_text: 'v2', session_id: 's1',
    });
    proxy.supersedePriorHead('ui_ux/filter', newId);
    proxy.finalizeNoteCompliance('s1');
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'superseded' })).toHaveLength(1);
    expect(proxy.getNoteEvents({ note_id: noteId, event_type: 'ignored' })).toHaveLength(0);
  });

  it('skips notes already acked and is idempotent on a second call', () => {
    const proxy = freshDb();
    const acked = seedSurfaced(proxy, { nodeId: 'ui_ux/filter', sess: 's1' });
    const pending = seedSurfaced(proxy, { nodeId: 'security/auth', sess: 's1' });
    proxy.ackNoteCompliance('s1', { outcome: 'dg_continue', nodeId: 'ui_ux/filter', reason: 'ok' });
    expect(proxy.finalizeNoteCompliance('s1')).toBe(1);
    expect(proxy.getNoteEvents({ note_id: acked, event_type: 'complied' })).toHaveLength(1);
    expect(decidedEvents(proxy, acked)).toHaveLength(1);
    expect(proxy.getNoteEvents({ note_id: pending, event_type: 'ignored' })).toHaveLength(1);
    expect(proxy.finalizeNoteCompliance('s1')).toBe(0);
  });

  it('returns 0 for a session with nothing surfaced', () => {
    const proxy = freshDb();
    expect(proxy.finalizeNoteCompliance('empty-session')).toBe(0);
  });
});

describe('db.js — getNoteComplianceStats (S4.3)', () => {
  it('empty → all zero, compliance 0 (never NaN)', () => {
    const proxy = freshDb();
    const s = proxy.getNoteComplianceStats();
    expect(s.total).toBe(0);
    expect(s.complied).toBe(0);
    expect(s.compliance).toBe(0);
    expect(Number.isNaN(s.compliance)).toBe(false);
    expect(Number.isNaN(s.compliance_of_surfaced)).toBe(false);
  });

  it('computes compliance = complied / (complied + ignored) and complied / surfaced', () => {
    const proxy = freshDb();
    const n = proxy.insertNote({ file: 'a', node_id: 'ui_ux/filter', source: 's', confidence_level: 3, note_text: 'x' });
    const n2 = proxy.insertNote({ file: 'b', node_id: 'ui_ux/search', source: 's', confidence_level: 3, note_text: 'y' });
    // 4 surfaced opportunities: n in s1/s2/s3, n2 in s1 (re-surface in s1 dedups).
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's2', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's3', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n2, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'complied' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's2', event_type: 'complied' });
    proxy.insertNoteEvent({ note_id: n2, session_id: 's1', event_type: 'ignored' });

    const s = proxy.getNoteComplianceStats();
    expect(s.surfaced).toBe(4);
    expect(s.complied).toBe(2);
    expect(s.ignored).toBe(1);
    expect(s.compliance).toBeCloseTo(2 / 3, 6);
    expect(s.compliance_of_surfaced).toBeCloseTo(2 / 4, 6);
  });

  it('filters by session_id', () => {
    const proxy = freshDb();
    const n = proxy.insertNote({ file: 'a', node_id: 'ui_ux/filter', source: 's', confidence_level: 3, note_text: 'x' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'complied' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's2', event_type: 'ignored' });
    const s = proxy.getNoteComplianceStats({ session_id: 's1' });
    expect(s.complied).toBe(1);
    expect(s.ignored).toBe(0);
  });

  it('multi-tenant: stats scoped to project_path', () => {
    const db = loadDb();
    const projA = db.getDb('/proj/a');
    const projB = db.getDb('/proj/b');
    const na = projA.insertNote({ file: 'a', node_id: 'ui_ux/filter', source: 's', confidence_level: 3, note_text: 'x' });
    projA.insertNoteEvent({ note_id: na, session_id: 's1', event_type: 'complied' });
    expect(projB.getNoteComplianceStats().complied).toBe(0);
  });
});

describe('db.js — getAllFeatures (S2.B foundation)', () => {
  it('returns all features across continents, project-scoped', () => {
    const proxy = freshDb();
    proxy.upsertFeatureCentroid({ continent: 'ui_ux', country: 'filter', node_id: 'ui_ux/filter', embedding: null });
    proxy.upsertFeatureCentroid({ continent: 'ui_ux', country: 'sort', node_id: 'ui_ux/sort', embedding: null });
    proxy.upsertFeatureCentroid({ continent: 'security', country: 'auth', node_id: 'security/auth', embedding: null });
    const all = proxy.getAllFeatures();
    expect(all).toHaveLength(3);
    expect(all.map(f => f.node_id).sort()).toEqual(['security/auth', 'ui_ux/filter', 'ui_ux/sort']);
  });

  it('multi-tenant: features scoped to project_path', () => {
    const db = loadDb();
    const projA = db.getDb('/proj/a');
    const projB = db.getDb('/proj/b');
    projA.upsertFeatureCentroid({ continent: 'ui_ux', country: 'filter', node_id: 'ui_ux/filter', embedding: null });
    expect(projB.getAllFeatures()).toHaveLength(0);
    expect(projA.getAllFeatures()).toHaveLength(1);
  });

  it('empty → []', () => {
    const proxy = freshDb();
    expect(proxy.getAllFeatures()).toEqual([]);
  });
});
