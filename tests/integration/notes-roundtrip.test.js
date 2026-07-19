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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-notes-rt-'));
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
    } catch { /* Windows lock window */ }
  }
});

describe('notes + note_events — full lifecycle roundtrip', () => {
  it('writes one note, chains three events, reads back ordered timeline', () => {
    const db = loadDb();
    const proxy = db.getDb('/proj/dg');

    // 1) A heuristic producer (yol0) writes a note tied to a change row
    proxy.insertSession('sess-rt-1');
    const changeId = proxy.insertChange({
      session_id: 'sess-rt-1',
      file: 'src/engine/db.js',
      description: 'edit description',
      action: 'Edit',
      lines_start: 100,
      lines_end: 105,
    });
    const noteId = proxy.insertNote({
      session_id: 'sess-rt-1',
      related_change_id: changeId,
      file: 'src/engine/db.js',
      lines_start: 100,
      lines_end: 105,
      node_id: 'src/engine/db.js:insertChange',
      source: 'yol0_heuristic',
      confidence_level: 1,
      note_text: 'V1 CREATE TABLE değiştirilmemeli — fresh DB duplicate column riski',
      trigger_data: { matched_pattern: 'migration_table_edit' },
    });
    expect(noteId).toBeGreaterThan(0);

    // 2) Pre-edit surface event — note shown to Claude
    proxy.insertNoteEvent({
      note_id: noteId,
      session_id: 'sess-rt-1',
      event_type: 'surfaced',
      payload: { surface_target: 'pre-edit-warn', mw_id: 'protect:check' },
    });

    // 3) Post-edit same-file-edited event — Claude did touch the file
    proxy.insertNoteEvent({
      note_id: noteId,
      session_id: 'sess-rt-1',
      change_id: changeId,
      event_type: 'same_file_edited',
    });

    // 4) Manual quality label — user marked this useful via viz UI later
    proxy.insertNoteEvent({
      note_id: noteId,
      event_type: 'marked_useful',
      payload: { rater: 'umut', via: 'ringmap-button' },
    });

    // 5) Read back the timeline
    const note = proxy.getNotes({ session_id: 'sess-rt-1' })[0];
    expect(note.id).toBe(noteId);
    expect(note.related_change_id).toBe(changeId);
    expect(note.source).toBe('yol0_heuristic');

    const events = proxy.getNoteEvents({ note_id: noteId });
    expect(events).toHaveLength(3);
    // ASC by ts then id → write order preserved
    expect(events.map(e => e.event_type)).toEqual(['surfaced', 'same_file_edited', 'marked_useful']);
    expect(events[0].session_id).toBe('sess-rt-1');
    expect(events[1].change_id).toBe(changeId);
    expect(JSON.parse(events[2].payload)).toEqual({ rater: 'umut', via: 'ringmap-button' });
  });
});
