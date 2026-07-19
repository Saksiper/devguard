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

function loadCapture() {
  return require('../../src/engine/note-capture');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-note-capture-test-'));
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

// Write a real synthetic JSONL transcript whose LAST assistant block ends with
// the given text (so getLastAssistantText recovers it untruncated).
function writeTranscript(assistantText) {
  const p = path.join(tmpDir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'please do the work' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('note-capture — captureNoteFromTranscript', () => {
  it('captures a valid marker → head note + layered event', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const tp = writeTranscript('Implemented the filter UI. [DG-NOTE ui_ux/filter] added a debounced filter widget');

    const id = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    expect(id).toBeGreaterThan(0);

    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head).toBeDefined();
    expect(head.id).toBe(id);
    expect(head.note_text).toBe('added a debounced filter widget');
    expect(head.source).toBe('yol2_claude');
    expect(head.confidence_level).toBe(3);
    expect(head.file).toBe('ui_ux/filter');
    expect(head.session_id).toBe('sess-1');

    const events = db.getNoteEvents({ note_id: id });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('layered');
  });

  it('is idempotent: same marker twice → ONE note, second returns same id', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] added a debounced filter widget');

    const id1 = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    const id2 = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-2' });

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1);
    expect(db.getNotes({ node_id: 'ui_ux/filter' })).toHaveLength(1);
    // No second 'layered' event either — the second call is a pure no-op.
    expect(db.getNoteEvents({ note_id: id1 })).toHaveLength(1);
  });

  it('a different marker for the same node → new head, old superseded (single head)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();

    const tp1 = writeTranscript('Done. [DG-NOTE ui_ux/filter] added a debounced filter widget');
    const id1 = captureNoteFromTranscript(db, { transcriptPath: tp1, sessionId: 'sess-1' });

    const tp2 = writeTranscript('Refactored. [DG-NOTE ui_ux/filter] extended the filter to support range queries');
    const id2 = captureNoteFromTranscript(db, { transcriptPath: tp2, sessionId: 'sess-2' });

    expect(id2).not.toBe(id1);

    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.id).toBe(id2);
    expect(head.note_text).toBe('extended the filter to support range queries');

    const heads = db.getNotes({ node_id: 'ui_ux/filter' }).filter(r => r.superseded_by === null);
    expect(heads).toHaveLength(1);
    expect(heads[0].id).toBe(id2);

    const all = db.getNotes({ node_id: 'ui_ux/filter' });
    expect(all.find(r => r.id === id1).superseded_by).toBe(id2);
  });

  it('no marker → no-op (no note rows, returns null)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const tp = writeTranscript('I finished the task without leaving any structured marker.');

    const res = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    expect(res).toBeNull();
    expect(db.getNotes()).toHaveLength(0);
  });

  it('invalid marker [DG-NOTE bad/zone] → no-op (no note rows, returns null)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const tp = writeTranscript('Tried to note something. [DG-NOTE bad/zone] this should not persist');

    const res = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    expect(res).toBeNull();
    expect(db.getNotes()).toHaveLength(0);
  });

  it('idempotency holds for non-ASCII notes (sanitize symmetry, no double write)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    // ligatures + full-width chars that NFKC-normalize inside sanitize()
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] ﬁxed the ﬁlter for ｆｕｌｌwidth input');

    const id1 = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's1' });
    const id2 = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's2' });

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1); // second call is a no-op despite non-ASCII text
    expect(db.getNotes({ node_id: 'ui_ux/filter' })).toHaveLength(1);
    expect(db.getNoteEvents({ note_id: id1 })).toHaveLength(1);
  });

  it('a bare marker with no note text is a no-op (does not supersede a good head)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const id1 = captureNoteFromTranscript(db, {
      transcriptPath: writeTranscript('Done. [DG-NOTE ui_ux/filter] added the real filter note'),
      sessionId: 's1',
    });
    const res = captureNoteFromTranscript(db, {
      transcriptPath: writeTranscript('Summary only. [DG-NOTE ui_ux/filter]'),
      sessionId: 's2',
    });

    expect(res).toBeNull();
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.id).toBe(id1); // good head preserved, not superseded by an empty note
    expect(head.note_text).toBe('added the real filter note');
  });

  it('a note that is only zero-width chars is a no-op post-sanitize (keeps good head)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const id1 = captureNoteFromTranscript(db, {
      transcriptPath: writeTranscript('Done. [DG-NOTE ui_ux/filter] added the real filter note'),
      sessionId: 's1',
    });
    const res = captureNoteFromTranscript(db, {
      transcriptPath: writeTranscript('[DG-NOTE ui_ux/filter] ​​'),
      sessionId: 's2',
    });

    expect(res).toBeNull();
    expect(db.getHeadNoteByNode('ui_ux/filter').id).toBe(id1);
  });
});

describe('note-capture — marker overrides S1 classifier (S3.3.4)', () => {
  it('links the new note to the change it describes (related_change_id)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const changeId = db.insertChange({ session_id: 'sess-1', file: 'src/filter.js', action: 'edit', description: 'add filter' });
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] added a debounced filter widget');

    const id = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.id).toBe(id);
    expect(head.related_change_id).toBe(changeId);
  });

  it('does NOT merge (destructively fuse) when the latest change is on a different feature', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    // S1 classifier placed the latest change under ui_ux/sort, which carries its own
    // accumulated history. A nodeId-only marker cannot be correlated to a specific
    // edit, so we must not irreversibly fuse ui_ux/sort into the marker node.
    const changeId = db.insertChange({ session_id: 'sess-1', file: 'src/filter.js', action: 'edit', description: 'add filter' });
    db.updateChangeNodeId(changeId, 'ui_ux/sort');
    const classifierNote = db.insertNote({ file: 'ui_ux/sort', node_id: 'ui_ux/sort', source: 'yol1', confidence_level: 2, note_text: 'auto placed', session_id: 'sess-1' });

    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] this is really the filter feature');
    const id = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });

    // ui_ux/sort keeps its note (not moved), the marker note lands under ui_ux/filter,
    // and the note is NOT mis-linked to a change the marker did not annotate.
    const sortNotes = db.getNotes({ node_id: 'ui_ux/sort' });
    expect(sortNotes.map(r => r.id)).toContain(classifierNote);
    expect(db.getHeadNoteByNode('ui_ux/sort').id).toBe(classifierNote);
    expect(db.getHeadNoteByNode('ui_ux/filter').id).toBe(id);
    expect(db.getHeadNoteByNode('ui_ux/filter').related_change_id).toBeNull();
  });

  it('does not destructively fuse an unrelated feature when a later edit is on another feature', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    // Two edits this session on two features; the marker is about the EARLIER feature,
    // but the session-latest change is the LATER, unrelated one.
    const c1 = db.insertChange({ session_id: 's1', file: 'src/routes.js', action: 'edit', description: 'routing' });
    db.updateChangeNodeId(c1, 'api/routes');
    const c2 = db.insertChange({ session_id: 's1', file: 'src/filter.js', action: 'edit', description: 'filter' });
    db.updateChangeNodeId(c2, 'ui_ux/filter');
    // ui_ux/filter has real accumulated history that must survive.
    const existing = db.insertNote({ file: 'ui_ux/filter', node_id: 'ui_ux/filter', source: 'yol2_claude', confidence_level: 3, note_text: 'existing filter history', session_id: 's0' });

    const tp = writeTranscript('Refactored routing. [DG-NOTE api/routes] cleaned up the router');
    captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's1' });

    // ui_ux/filter must NOT have been fused into api/routes.
    expect(db.getNotes({ node_id: 'ui_ux/filter' }).map(r => r.id)).toContain(existing);
    expect(db.getHeadNoteByNode('ui_ux/filter').id).toBe(existing);
  });

  it('reflection turn: does not fuse a prior-turn feature nor mis-link the note', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    // A prior turn edited security/auth (with history); this turn makes no matching
    // edit and the marker names a DIFFERENT feature.
    const c1 = db.insertChange({ session_id: 's1', file: 'src/auth.js', action: 'edit', description: 'auth' });
    db.updateChangeNodeId(c1, 'security/auth');
    const authNote = db.insertNote({ file: 'security/auth', node_id: 'security/auth', source: 'yol2_claude', confidence_level: 3, note_text: 'auth history', session_id: 's0' });

    const tp = writeTranscript('Reflecting on the design. [DG-NOTE ui_ux/filter] refined the debounce');
    const id = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's1' });

    // security/auth is untouched, and the note is not linked to the unrelated auth edit.
    expect(db.getHeadNoteByNode('security/auth').id).toBe(authNote);
    expect(db.getHeadNoteByNode('ui_ux/filter').id).toBe(id);
    expect(db.getHeadNoteByNode('ui_ux/filter').related_change_id).toBeNull();
  });

  it('does not merge when classifier node equals marker node', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const changeId = db.insertChange({ session_id: 'sess-1', file: 'src/filter.js', action: 'edit', description: 'add filter' });
    db.updateChangeNodeId(changeId, 'ui_ux/filter');
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] added a debounced filter widget');
    const id = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.id).toBe(id);
    expect(head.related_change_id).toBe(changeId);
    expect(db.getNotes({ node_id: 'ui_ux/filter' })).toHaveLength(1);
  });
});

describe('note-capture — staleness fingerprint (V16)', () => {
  it('stores source_file + code_fingerprint from the attributable change', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const srcFile = path.join(tmpDir, 'filter.js');
    fs.writeFileSync(srcFile, 'export function filter() { /* v1 */ }');
    db.insertChange({ session_id: 'sess-1', file: srcFile, action: 'edit', description: 'add filter' });
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] added a debounced filter widget');

    const id = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.id).toBe(id);
    expect(head.source_file).toBe(srcFile);
    expect(head.code_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves source_file + code_fingerprint NULL when there is no attributable change', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const tp = writeTranscript('Reflecting only. [DG-NOTE ui_ux/filter] refined the debounce');

    captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 'sess-1' });
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.source_file).toBeNull();
    expect(head.code_fingerprint).toBeNull();
  });

  it('leaves fingerprint NULL when the latest change is a different feature (not attributable)', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const srcFile = path.join(tmpDir, 'sort.js');
    fs.writeFileSync(srcFile, 'sort impl');
    const cid = db.insertChange({ session_id: 's1', file: srcFile, action: 'edit', description: 'sort' });
    db.updateChangeNodeId(cid, 'ui_ux/sort');
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] filter work');

    captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's1' });
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.source_file).toBeNull();
    expect(head.code_fingerprint).toBeNull();
  });

  // Documents the accepted boundary (review finding A): for a multi-file feature only
  // the LATEST edited file is pinned, so a later change to the OTHER file would not
  // flag this note stale. Locks the behavior so a future change can't silently alter it.
  it('known limitation: pins only the latest edited file for a multi-file feature', () => {
    const db = freshDb();
    const { captureNoteFromTranscript } = loadCapture();
    const fileA = path.join(tmpDir, 'parse.js');
    const fileB = path.join(tmpDir, 'apply.js');
    fs.writeFileSync(fileA, 'parse v1');
    fs.writeFileSync(fileB, 'apply v1');
    const cA = db.insertChange({ session_id: 's1', file: fileA, action: 'edit', description: 'parse' });
    db.updateChangeNodeId(cA, 'ui_ux/filter');
    const cB = db.insertChange({ session_id: 's1', file: fileB, action: 'edit', description: 'apply' });
    db.updateChangeNodeId(cB, 'ui_ux/filter');
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] filter across two files');

    captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's1' });
    const head = db.getHeadNoteByNode('ui_ux/filter');
    expect(head.source_file).toBe(fileB); // only the latest file, not fileA
    expect(head.code_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Seed a note whose surfaced event belongs to session `sess` (the note itself may
// come from an earlier session, as in production).
function seedSurfaced(db, { nodeId, sess, text }) {
  const noteId = db.insertNote({
    file: nodeId, node_id: nodeId, source: 'yol2_claude', confidence_level: 3,
    note_text: text || 'prior-' + nodeId, session_id: 'earlier-session',
  });
  db.insertNoteEvent({ note_id: noteId, session_id: sess, event_type: 'surfaced' });
  return noteId;
}

describe('note-capture — captureAckCompliance', () => {
  it('credits complied to the surfaced note from an ack tag in the last reply', () => {
    const db = freshDb();
    const { captureAckCompliance } = loadCapture();
    const noteId = seedSurfaced(db, { nodeId: 'ui_ux/filter', sess: 's1' });
    const tp = writeTranscript('Done.\n[DG-CONTINUE ui_ux/filter] kept the tokenized search.');

    const emitted = captureAckCompliance(db, { transcriptPath: tp, sessionId: 's1' });
    expect(emitted).toBe(1);
    const ev = db.getNoteEvents({ note_id: noteId, event_type: 'complied' });
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload).via).toBe('stop_ack');
  });

  it('ack+note single block: layer first, then the ack still credits complied', () => {
    const db = freshDb();
    const { captureNoteFromTranscript, captureAckCompliance } = loadCapture();
    const priorId = seedSurfaced(db, { nodeId: 'ui_ux/filter', sess: 's1', text: 'v1 decision' });
    const tp = writeTranscript(
      'Extended the filter.\n' +
      '[DG-CONTINUE ui_ux/filter] kept the v1 decision and extended it.\n' +
      '[DG-NOTE ui_ux/filter] added range filtering on top of v1.'
    );

    // Hook order: note capture layers the new head, THEN the ack harvest runs.
    const newId = captureNoteFromTranscript(db, { transcriptPath: tp, sessionId: 's1' });
    const emitted = captureAckCompliance(db, { transcriptPath: tp, sessionId: 's1' });

    expect(newId).toBeGreaterThan(0);
    expect(db.getHeadNoteByNode('ui_ux/filter').id).toBe(newId);
    expect(emitted).toBe(1);
    expect(db.getNoteEvents({ note_id: priorId, event_type: 'complied' })).toHaveLength(1);
    expect(db.getNoteEvents({ note_id: priorId, event_type: 'superseded' })).toHaveLength(0);
  });

  it('writes nothing when the reply has no ack tag', () => {
    const db = freshDb();
    const { captureAckCompliance } = loadCapture();
    const noteId = seedSurfaced(db, { nodeId: 'ui_ux/filter', sess: 's1' });
    const tp = writeTranscript('Done. [DG-NOTE ui_ux/filter] a note without any ack.');

    expect(captureAckCompliance(db, { transcriptPath: tp, sessionId: 's1' })).toBe(0);
    const decided = db.getNoteEvents({ note_id: noteId })
      .filter(e => ['complied', 'ignored', 'superseded'].includes(e.event_type));
    expect(decided).toHaveLength(0);
  });

  it('drops a tag whose node token is not a valid node id', () => {
    const db = freshDb();
    const { captureAckCompliance } = loadCapture();
    const noteId = seedSurfaced(db, { nodeId: 'ui_ux/filter', sess: 's1' });
    const tp = writeTranscript('[DG-CONTINUE bogus/zone] whatever.');

    expect(captureAckCompliance(db, { transcriptPath: tp, sessionId: 's1' })).toBe(0);
    const decided = db.getNoteEvents({ note_id: noteId })
      .filter(e => ['complied', 'ignored', 'superseded'].includes(e.event_type));
    expect(decided).toHaveLength(0);
  });

  it('an echo-less tag is dropped even in a single-node session (cycle-warn cross-talk guard)', () => {
    // A bare [DG-CONTINUE] can be the answer to the pre-edit cycle-warn directive;
    // crediting it to the surfaced note would fake sphere compliance. Echo required.
    const db = freshDb();
    const { captureAckCompliance } = loadCapture();
    const noteId = seedSurfaced(db, { nodeId: 'ui_ux/filter', sess: 's1' });
    const tp = writeTranscript('[DG-CONTINUE] this approach will work because the retry backoff is idempotent.');

    expect(captureAckCompliance(db, { transcriptPath: tp, sessionId: 's1' })).toBe(0);
    const decided = db.getNoteEvents({ note_id: noteId })
      .filter(e => ['complied', 'ignored', 'superseded'].includes(e.event_type));
    expect(decided).toHaveLength(0);
  });

  it('returns 0 without a session id (defensive)', () => {
    const db = freshDb();
    const { captureAckCompliance } = loadCapture();
    const tp = writeTranscript('[DG-CONTINUE ui_ux/filter] ok.');
    expect(captureAckCompliance(db, { transcriptPath: tp })).toBe(0);
  });
});
