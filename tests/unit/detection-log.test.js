import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let tmpDir, projectDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-detlog-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-proj-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});

afterEach(() => {
  try { require('../../src/engine/db').closeDb(); } catch { /* cleanup */ }
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  delete process.env.CLAUDE_PLUGIN_DATA;
  for (const dir of [tmpDir, projectDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win lock */ }
  }
});

describe('Migration V5 — detection_log table', () => {
  it('creates detection_log table on DB open', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id = db.insertDetection({
      session_id: 's1', file: 'app.js', decision: 'warn',
      level: 1, type: 'file_match', confidence: 0.8, message: 'test',
    });
    expect(id).toBeGreaterThan(0);
    closeDb();
  });
});

describe('insertDetection', () => {
  it('inserts warn and block events', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn', level: 1, type: 'file_match' });
    db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'block', level: 2, type: 'diff_match' });
    const all = db.getDetections({});
    expect(all).toHaveLength(2);
    expect(all[0].decision).toBe('block');
    expect(all[1].decision).toBe('warn');
    closeDb();
  });

  it('stores middleware_id, confidence, message', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertDetection({
      session_id: 's1', file: 'x.js', decision: 'warn',
      middleware_id: 'cycle:file_match', level: 1, type: 'file_match',
      confidence: 0.95, message: 'Bu dosya 3 kez duzenlendi.',
    });
    const [d] = db.getDetections({});
    expect(d.middleware_id).toBe('cycle:file_match');
    expect(d.confidence).toBeCloseTo(0.95);
    expect(d.message).toContain('3 kez');
    expect(d.classification).toBeNull();
    closeDb();
  });
});

describe('getDetections', () => {
  it('filters by session_id', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    db.insertDetection({ session_id: 's2', file: 'b.js', decision: 'block' });
    const s1 = db.getDetections({ session_id: 's1' });
    expect(s1).toHaveLength(1);
    expect(s1[0].file).toBe('a.js');
    closeDb();
  });

  it('filters unclassified only', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id1 = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'block' });
    db.classifyDetection(id1, 'tp', null);
    const unclassified = db.getDetections({ unclassified: true });
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0].file).toBe('b.js');
    closeDb();
  });

  it('respects limit', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    for (let i = 0; i < 10; i++) {
      db.insertDetection({ session_id: 's1', file: `f${i}.js`, decision: 'warn' });
    }
    const limited = db.getDetections({ limit: 3 });
    expect(limited).toHaveLength(3);
    closeDb();
  });

  it('multi-tenant: project isolation', () => {
    const { getDb, closeDb } = loadDb();
    const db1 = getDb(projectDir);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-other-'));
    const db2 = getDb(otherDir);
    db1.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    db2.insertDetection({ session_id: 's2', file: 'b.js', decision: 'block' });
    expect(db1.getDetections({})).toHaveLength(1);
    expect(db2.getDetections({})).toHaveLength(1);
    expect(db1.getDetections({})[0].file).toBe('a.js');
    closeDb();
    try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch { /* win */ }
  });
});

describe('classifyDetection', () => {
  it('sets classification and classified_at', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    const changed = db.classifyDetection(id, 'fp', 'Farkli fonksiyonlari duzenliyordum');
    expect(changed).toBe(1);
    const [d] = db.getDetections({});
    expect(d.classification).toBe('fp');
    expect(d.classified_at).toBeTruthy();
    expect(d.classification_note).toContain('Farkli');
    closeDb();
  });

  it('returns 0 for non-existent id', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const changed = db.classifyDetection(9999, 'tp', null);
    expect(changed).toBe(0);
    closeDb();
  });

  it('returns 0 for wrong project', () => {
    const { getDb, closeDb } = loadDb();
    const db1 = getDb(projectDir);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-other2-'));
    const db2 = getDb(otherDir);
    const id = db1.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    const changed = db2.classifyDetection(id, 'tp', null);
    expect(changed).toBe(0);
    closeDb();
    try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch { /* win */ }
  });
});

describe('getDetectionStats', () => {
  it('counts tp, fp, fn, unclassified', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id1 = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    const id2 = db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'block' });
    db.insertDetection({ session_id: 's1', file: 'c.js', decision: 'warn' });
    db.classifyDetection(id1, 'tp', null);
    db.classifyDetection(id2, 'fp', 'yanlis alarm');
    const stats = db.getDetectionStats({});
    expect(stats.total).toBe(3);
    expect(stats.tp).toBe(1);
    expect(stats.fp).toBe(1);
    expect(stats.fn).toBe(0);
    expect(stats.unclassified).toBe(1);
    closeDb();
  });

  it('filters by session_id', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    db.insertDetection({ session_id: 's2', file: 'b.js', decision: 'block' });
    const stats = db.getDetectionStats({ session_id: 's1' });
    expect(stats.total).toBe(1);
    closeDb();
  });

  it('empty DB returns zeros', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const stats = db.getDetectionStats({});
    expect(stats).toEqual({ total: 0, tp: 0, fp: 0, fn: 0, unclassified: 0 });
    closeDb();
  });
});

describe('insertFalseNegative', () => {
  it('inserts fn record with classification pre-set', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id = db.insertFalseNegative({ session_id: 's1', note: 'Dongudeydim ama yakalamadi' });
    expect(id).toBeGreaterThan(0);
    const stats = db.getDetectionStats({});
    expect(stats.fn).toBe(1);
    expect(stats.total).toBe(1);
    expect(stats.unclassified).toBe(0);
    const [d] = db.getDetections({});
    expect(d.decision).toBe('fn');
    expect(d.classification).toBe('fn');
    expect(d.classification_note).toContain('yakalamadi');
    closeDb();
  });
});

describe('deleteByProjectPath includes detection_log', () => {
  it('cleans up detection_log on orphan delete', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    expect(db.getDetections({})).toHaveLength(1);
    db.deleteByProjectPath(projectDir);
    expect(db.getDetections({})).toHaveLength(0);
    closeDb();
  });
});

describe('classifyOutcome (DG-tag based)', () => {
  it('returns no_reasoning when reasoning is empty', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome(null, true)).toBe('no_reasoning');
    expect(classifyOutcome('', false)).toBe('no_reasoning');
  });

  it('detects [DG-CONTINUE] tag', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-CONTINUE] Edge case is rare, current fix is correct.', true)).toBe('dg_continue');
    expect(classifyOutcome('[dg-continue] lowercase also ok', false)).toBe('dg_continue');
  });

  it('detects [DG-PIVOT] tag', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-PIVOT] Different root cause, switching to db layer.', false)).toBe('dg_pivot');
    expect(classifyOutcome('Preface text. [DG-PIVOT] still detected.', true)).toBe('dg_pivot');
  });

  it('detects [DG-PAUSE] tag', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-PAUSE] Need to read related code first.', true)).toBe('dg_pause');
  });

  it('classifies untagged reasoning as dg_none', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('Testleri JSONL formatına güncelliyorum', true)).toBe('dg_none');
    expect(classifyOutcome('Now updating the other file', false)).toBe('dg_none');
  });

  it('PIVOT wins over CONTINUE if both present (Claude self-corrected)', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-CONTINUE] wait actually [DG-PIVOT] better path', false)).toBe('dg_pivot');
  });

  it('detects node-echoed tags ([DG-CONTINUE ui_ux/filter] form)', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-CONTINUE ui_ux/filter] kept the tokenized search', true)).toBe('dg_continue');
    expect(classifyOutcome('[DG-PIVOT security/auth] switched approach', false)).toBe('dg_pivot');
    expect(classifyOutcome('[DG-PAUSE ui_ux/search] reading first', true)).toBe('dg_pause');
  });

  it('node-echoed PIVOT still wins over CONTINUE', () => {
    const { classifyOutcome } = loadDb();
    expect(
      classifyOutcome('[DG-CONTINUE ui_ux/filter] hmm [DG-PIVOT ui_ux/filter] better', false)
    ).toBe('dg_pivot');
  });

  it('does not match look-alike words such as [DG-CONTINUED]', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-CONTINUED] not a tag', false)).toBe('dg_none');
  });

  it('the echo part must stay on one line (no multi-line false positive)', () => {
    const { classifyOutcome } = loadDb();
    expect(classifyOutcome('[DG-CONTINUE\nsome text\nmore lines\nblah]', false)).toBe('dg_none');
    expect(classifyOutcome('I did [DG-CONTINUE now let me note\nthe arr[0]] done', false)).toBe('dg_none');
  });
});

describe('trackDetectionOutcome', () => {
  it('writes reasoning and outcome to next_change_* columns', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');
    const detId = db.insertDetection({
      session_id: 's1', file: 'a.js', decision: 'warn',
      middleware_id: 'cycle:diff_match', message: 'cycle warn',
    });
    const changeId = db.insertChange({ session_id: 's1', file: 'a.js', action: 'Edit' });

    const updated = db.trackDetectionOutcome('s1', changeId, 'a.js', 'devam ediyorum normal şekilde');
    expect(updated).toBe(1);

    const [outcomeRow] = db.getDetectionOutcomes({ session_id: 's1' });
    expect(outcomeRow.id).toBe(detId);
    expect(outcomeRow.next_change_same_file).toBe(1);
    expect(outcomeRow.next_change_reasoning).toContain('devam ediyorum');
    expect(outcomeRow.next_change_outcome).toBe('dg_none');
    closeDb();
  });

  it('classifies tagged [DG-PIVOT] reasoning as dg_pivot', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');
    db.insertDetection({ session_id: 's1', file: 'old.js', decision: 'warn', message: 'cycle' });
    const changeId = db.insertChange({ session_id: 's1', file: 'new.js', action: 'Edit' });

    db.trackDetectionOutcome('s1', changeId, 'new.js', '[DG-PIVOT] Trying a different layer.');
    const [row] = db.getDetectionOutcomes({ session_id: 's1' });
    expect(row.next_change_same_file).toBe(0);
    expect(row.next_change_outcome).toBe('dg_pivot');
    closeDb();
  });

  it('skip-classifies missing reasoning as no_reasoning', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');
    db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn', message: 'cycle' });
    const changeId = db.insertChange({ session_id: 's1', file: 'b.js', action: 'Edit' });

    db.trackDetectionOutcome('s1', changeId, 'b.js', null);
    const [row] = db.getDetectionOutcomes({ session_id: 's1' });
    expect(row.next_change_reasoning).toBeNull();
    expect(row.next_change_outcome).toBe('no_reasoning');
    closeDb();
  });

  it('filters getDetectionOutcomes by outcome and has_reasoning', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');
    db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn', message: 'cycle' });
    const c1 = db.insertChange({ session_id: 's1', file: 'a.js', action: 'Edit' });
    db.trackDetectionOutcome('s1', c1, 'a.js', 'devam ediyorum');

    db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'warn', message: 'cycle' });
    const c2 = db.insertChange({ session_id: 's1', file: 'b.js', action: 'Edit' });
    db.trackDetectionOutcome('s1', c2, 'b.js', null);

    const withReasoning = db.getDetectionOutcomes({ session_id: 's1', has_reasoning: true });
    expect(withReasoning).toHaveLength(1);
    expect(withReasoning[0].next_change_reasoning).toContain('devam');

    const untagged = db.getDetectionOutcomes({ session_id: 's1', outcome: 'dg_none' });
    expect(untagged).toHaveLength(1);
    closeDb();
  });
});

describe('linkDetectionsToChange / labelDetectionOutcome (S4.1 decoupled)', () => {
  it('links each detection to ITS OWN change at insert (no off-by-one), labels retro', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');

    // D1 fires, then C1 edits file A -> D1 links to C1 at insert.
    const d1 = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn', middleware_id: 'm1' });
    const c1 = db.insertChange({ session_id: 's1', file: 'a.js', action: 'Edit' });
    expect(db.linkDetectionsToChange('s1', c1, 'a.js')).toBe(1);

    // D2 fires, then C2 edits file B -> only D2 links to C2 (D1 already linked).
    const d2 = db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'warn', middleware_id: 'm2' });
    const c2 = db.insertChange({ session_id: 's1', file: 'b.js', action: 'Edit' });
    expect(db.linkDetectionsToChange('s1', c2, 'b.js')).toBe(1);

    const rowById = (id) => db.getDetections({ session_id: 's1' }).find(r => r.id === id);
    // The off-by-one bug scoops BOTH D1 and D2 onto the change passed last.
    expect(Number(rowById(d1).next_change_id)).toBe(Number(c1));
    expect(Number(rowById(d2).next_change_id)).toBe(Number(c2));
    expect(rowById(d1).next_change_same_file).toBe(1);
    expect(rowById(d2).next_change_same_file).toBe(1);
    // Linking leaves outcome/reasoning NULL — labeling is a separate retro step.
    expect(rowById(d1).next_change_outcome).toBeNull();
    expect(rowById(d2).next_change_outcome).toBeNull();

    // C1's reply arrives -> label ONLY C1's detection.
    expect(db.labelDetectionOutcome('s1', c1, '[DG-PIVOT] switched layers')).toBe(1);
    expect(rowById(d1).next_change_outcome).toBe('dg_pivot');
    expect(rowById(d1).next_change_reasoning).toContain('DG-PIVOT');
    // D2 stays unlabeled until ITS OWN reply is labeled.
    expect(rowById(d2).next_change_outcome).toBeNull();

    expect(db.labelDetectionOutcome('s1', c2, 'devam ediyorum')).toBe(1);
    expect(rowById(d2).next_change_outcome).toBe('dg_none');
    closeDb();
  });
});

describe('Migration V10 — verdict to reasoning rename', () => {
  it('exposes next_change_reasoning and next_change_outcome columns', () => {
    const { getDb, closeDb, openDb } = loadDb();
    getDb(projectDir); // triggers migration
    const sqliteDb = openDb();
    const cols = sqliteDb.prepare('PRAGMA table_info(detection_log)').all().map(c => c.name);
    expect(cols).toContain('next_change_reasoning');
    expect(cols).toContain('next_change_outcome');
    expect(cols).not.toContain('next_change_verdict');
    closeDb();
  });
});
