'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url); // eslint-disable-line no-unused-vars

let watcher;
let tmpDir;
let dbPath;

function setupDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-watcher-'));
  dbPath = path.join(tmpDir, 'devguard.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      pending_summary TEXT,
      last_injection_change_id INTEGER DEFAULT 0
    );
    CREATE TABLE changes (
      id INTEGER PRIMARY KEY,
      project_path TEXT NOT NULL,
      session_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      file TEXT NOT NULL,
      lines_start INTEGER, lines_end INTEGER,
      action TEXT, description TEXT,
      description_embedding BLOB, diff_text TEXT, diff_embedding BLOB,
      related_issue_id INTEGER, verdict TEXT, claude_verdict TEXT,
      verdict_quality INTEGER DEFAULT 1
    );
    CREATE TABLE detection_log (
      id INTEGER PRIMARY KEY,
      project_path TEXT NOT NULL,
      session_id TEXT,
      file TEXT NOT NULL,
      middleware_id TEXT,
      decision TEXT NOT NULL,
      level INTEGER, type TEXT, confidence REAL,
      message TEXT,
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      classification TEXT, classified_at DATETIME, classification_note TEXT,
      next_change_id INTEGER, next_change_same_file INTEGER, next_change_seconds INTEGER
    );
  `);
  db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run('sess1', 'C:/test/proj');
  return db;
}

function loadWatcher() {
  vi.stubEnv('CLAUDE_PLUGIN_DATA', tmpDir);
  vi.stubEnv('CLAUDE_PROJECT_DIR', 'C:\\test\\proj');
  // Clear module cache
  delete require.cache[require.resolve('../../src/monitors/session-watcher.js')];
  watcher = require('../../src/monitors/session-watcher.js');
  // Reset state
  watcher.state.sessionId = null;
  watcher.state.fatigueWarned = false;
  watcher.state.velocityCooldowns.clear();
  watcher.state.lastBounceHash = null;
  watcher.state.lastBounceTime = 0;
  watcher.state.effectivenessCooldowns.clear();
}

function insertChanges(db, count, file, sessionId = 'sess1', pp = 'C:/test/proj') {
  const stmt = db.prepare(
    `INSERT INTO changes (project_path, session_id, file, timestamp, action)
     VALUES (?, ?, ?, datetime('now', ?), 'Edit')`
  );
  for (let i = 0; i < count; i++) {
    stmt.run(pp, sessionId, file, `-${count - i} seconds`);
  }
}

function insertDetection(db, file, opts = {}) {
  db.prepare(
    `INSERT INTO detection_log (project_path, session_id, file, decision, level, type, confidence, message,
     detected_at, next_change_same_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)`
  ).run(
    opts.pp || 'C:/test/proj',
    opts.sessionId || 'sess1',
    file,
    opts.decision || 'warn',
    opts.level || 1,
    opts.type || 'file_match',
    opts.confidence || 0.8,
    opts.message || 'test warn',
    opts.timeOffset || '0 seconds',
    opts.nextSameFile ?? null,
  );
}

describe('session-watcher', () => {
  let db;
  let stdoutSpy;

  beforeEach(() => {
    db = setupDb();
    loadWatcher();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    db.close();
    stdoutSpy.mockRestore();
    vi.unstubAllEnvs();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  // --- emit ---

  it('emit writes single line with prefix', () => {
    watcher.emit('test message');
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls[0][0];
    expect(output).toContain("I'm DevGuard (session monitor).");
    expect(output).toContain('test message');
    expect(output.endsWith('\n')).toBe(true);
    expect(output.split('\n').filter(Boolean)).toHaveLength(1);
  });

  // --- Edit Velocity ---

  it('velocity: 5+ edits on same file in 2 min → warn', () => {
    insertChanges(db, 6, 'C:/test/proj/src/app.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkEditVelocity(readDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, []);
    readDb.close();
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdoutSpy.mock.calls[0][0]).toContain('app.ts');
    expect(stdoutSpy.mock.calls[0][0]).toContain('root cause');
  });

  it('velocity: 4 edits → silent', () => {
    insertChanges(db, 4, 'C:/test/proj/src/app.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkEditVelocity(readDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, []);
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('velocity: hook already warned → silent', () => {
    insertChanges(db, 6, 'C:/test/proj/src/app.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkEditVelocity(readDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, ['C:/test/proj/src/app.ts']);
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('velocity: cooldown prevents re-warn within 5 min', () => {
    insertChanges(db, 6, 'C:/test/proj/src/app.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkEditVelocity(readDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, []);
    expect(stdoutSpy).toHaveBeenCalledOnce();
    stdoutSpy.mockClear();
    watcher.checkEditVelocity(readDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, []);
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('velocity: different files above threshold are independent', () => {
    insertChanges(db, 6, 'C:/test/proj/a.ts');
    insertChanges(db, 6, 'C:/test/proj/b.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkEditVelocity(readDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, []);
    readDb.close();
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
  });

  // --- Cross-File Bouncing ---

  it('bounce: A→B→A→B→A pattern in 10 edits → warn', () => {
    const stmt = db.prepare(
      `INSERT INTO changes (project_path, session_id, file, timestamp, action)
       VALUES (?, ?, ?, datetime('now', ?), 'Edit')`
    );
    const files = ['C:/proj/a.ts', 'C:/proj/b.ts'];
    for (let i = 0; i < 10; i++) {
      stmt.run('C:/test/proj', 'sess1', files[i % 2], `-${10 - i} seconds`);
    }
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkCrossFileBounce(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdoutSpy.mock.calls[0][0]).toContain('bouncing');
  });

  it('bounce: less than 10 edits → silent', () => {
    insertChanges(db, 8, 'C:/proj/a.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkCrossFileBounce(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('bounce: 4+ unique files → silent (not a bounce)', () => {
    const stmt = db.prepare(
      `INSERT INTO changes (project_path, session_id, file, timestamp, action)
       VALUES (?, ?, ?, datetime('now', ?), 'Edit')`
    );
    for (let i = 0; i < 10; i++) {
      stmt.run('C:/test/proj', 'sess1', `C:/proj/file${i}.ts`, `-${10 - i} seconds`);
    }
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkCrossFileBounce(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('bounce: same hash within cooldown → silent', () => {
    const stmt = db.prepare(
      `INSERT INTO changes (project_path, session_id, file, timestamp, action)
       VALUES (?, ?, ?, datetime('now', ?), 'Edit')`
    );
    for (let i = 0; i < 10; i++) {
      stmt.run('C:/test/proj', 'sess1', i % 2 === 0 ? 'C:/proj/a.ts' : 'C:/proj/b.ts', `-${10 - i} seconds`);
    }
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkCrossFileBounce(readDb, 'C:/test/proj', 'sess1');
    expect(stdoutSpy).toHaveBeenCalledOnce();
    stdoutSpy.mockClear();
    watcher.checkCrossFileBounce(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // --- Warn Effectiveness ---

  it('effectiveness: 3+ warns with next_change_same_file=1 → escalation', () => {
    for (let i = 0; i < 4; i++) {
      insertDetection(db, 'C:/test/proj/src/comp.tsx', {
        nextSameFile: 1,
        timeOffset: `-${4 - i} minutes`,
      });
    }
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkWarnEffectiveness(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdoutSpy.mock.calls[0][0]).toContain('comp.tsx');
    expect(stdoutSpy.mock.calls[0][0]).toContain('confident');
  });

  it('effectiveness: 2 warns → silent (below threshold)', () => {
    for (let i = 0; i < 2; i++) {
      insertDetection(db, 'C:/test/proj/src/comp.tsx', { nextSameFile: 1 });
    }
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkWarnEffectiveness(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('effectiveness: warns with next_change_same_file=0 → silent', () => {
    for (let i = 0; i < 5; i++) {
      insertDetection(db, 'C:/test/proj/src/comp.tsx', { nextSameFile: 0 });
    }
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkWarnEffectiveness(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // --- Session Fatigue ---

  it('fatigue: 50+ changes → warn once', () => {
    insertChanges(db, 52, 'C:/test/proj/src/many.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkSessionFatigue(readDb, 'C:/test/proj', 'sess1', { monitor_fatigue_threshold: 50 });
    expect(stdoutSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy.mock.calls[0][0]).toContain('52 changes');
    stdoutSpy.mockClear();
    watcher.checkSessionFatigue(readDb, 'C:/test/proj', 'sess1', { monitor_fatigue_threshold: 50 });
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('fatigue: 49 changes → silent', () => {
    insertChanges(db, 49, 'C:/test/proj/src/many.ts');
    const readDb = new Database(dbPath, { readonly: true });
    watcher.checkSessionFatigue(readDb, 'C:/test/proj', 'sess1', { monitor_fatigue_threshold: 50 });
    readDb.close();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // --- getRecentHookWarns ---

  it('getRecentHookWarns returns files warned in last 5 min', () => {
    insertDetection(db, 'C:/test/proj/src/warned.ts');
    const readDb = new Database(dbPath, { readonly: true });
    const files = watcher.getRecentHookWarns(readDb, 'C:/test/proj', 'sess1');
    readDb.close();
    expect(files).toContain('C:/test/proj/src/warned.ts');
  });

  // --- State reset on new session ---

  it('new session resets state', () => {
    watcher.state.sessionId = 'old-session';
    watcher.state.fatigueWarned = true;
    watcher.state.velocityCooldowns.set('x', 123);

    insertChanges(db, 52, 'C:/test/proj/src/f.ts');
    watcher.poll('C:/test/proj');

    expect(watcher.state.sessionId).toBe('sess1');
    expect(watcher.state.fatigueWarned).toBe(true); // set again by fatigue check
  });

  // --- monitor_enabled: false ---

  it('monitor_enabled: false → silent (via config file)', () => {
    insertChanges(db, 52, 'C:/test/proj/src/f.ts');
    // Create a config file that disables monitor
    const configDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'devguard.config.yaml'), 'monitor_enabled: false\n');
    watcher.poll(configDir);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // --- DB error graceful ---

  it('DB error does not crash', () => {
    const badDb = { prepare: () => { throw new Error('DB locked'); } };
    expect(() => {
      watcher.checkEditVelocity(badDb, 'C:/test/proj', 'sess1', { monitor_velocity_threshold: 5 }, []);
    }).not.toThrow();
    expect(() => {
      watcher.checkCrossFileBounce(badDb, 'C:/test/proj', 'sess1');
    }).not.toThrow();
    expect(() => {
      watcher.checkWarnEffectiveness(badDb, 'C:/test/proj', 'sess1');
    }).not.toThrow();
    expect(() => {
      watcher.checkSessionFatigue(badDb, 'C:/test/proj', 'sess1', { monitor_fatigue_threshold: 50 });
    }).not.toThrow();
  });
});
