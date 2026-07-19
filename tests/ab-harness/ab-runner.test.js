import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { buildConfigYaml, sandboxLayout, parseEnvelopeProxies, collectProxiesFromDb } = require('../../tools/dg-ab-runner');

describe('ab-runner: buildConfigYaml', () => {
  it('active arm enables intervention', () => {
    expect(buildConfigYaml('active')).toMatch(/intervention_enabled:\s*true/);
  });
  it('passive arm disables intervention', () => {
    expect(buildConfigYaml('passive')).toMatch(/intervention_enabled:\s*false/);
  });
});

describe('ab-runner: sandboxLayout', () => {
  it('produces a unique projectDir per (task, arm, replica)', () => {
    const a = sandboxLayout('/base', 'task1', 'passive', 1);
    const b = sandboxLayout('/base', 'task1', 'active', 1);
    const c = sandboxLayout('/base', 'task1', 'passive', 2);
    expect(new Set([a.projectDir, b.projectDir, c.projectDir]).size).toBe(3);
    expect(a.projectDir).toContain('task1');
  });
});

describe('ab-runner: parseEnvelopeProxies', () => {
  it('extracts num_turns, cost, error flag, reply, denials', () => {
    const env = JSON.stringify({ type: 'result', is_error: false, num_turns: 3, total_cost_usd: 0.05, result: 'ok', usage: { output_tokens: 42 }, permission_denials: [] });
    const p = parseEnvelopeProxies(env);
    expect(p.numTurns).toBe(3);
    expect(p.costUsd).toBeCloseTo(0.05);
    expect(p.isError).toBe(false);
    expect(p.reply).toBe('ok');
    expect(p.outputTokens).toBe(42);
    expect(p.permissionDenials).toBe(0);
  });
  it('treats a malformed envelope as degraded (isError true)', () => {
    expect(parseEnvelopeProxies('not json').isError).toBe(true);
  });
});

describe('ab-runner: collectProxiesFromDb', () => {
  let db;
  const PP = 'C:/x/proj';
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE changes (id INTEGER PRIMARY KEY, project_path TEXT, file TEXT);
             CREATE TABLE detection_log (id INTEGER PRIMARY KEY, project_path TEXT, decision TEXT);
             CREATE TABLE note_events (id INTEGER PRIMARY KEY, project_path TEXT, event_type TEXT);`);
  });

  it('counts changes, distinct files, and same-file max (tenant-scoped)', () => {
    const ins = db.prepare('INSERT INTO changes (project_path, file) VALUES (?, ?)');
    ins.run(PP, 'a.js'); ins.run(PP, 'a.js'); ins.run(PP, 'b.js');
    ins.run('OTHER', 'a.js'); // different tenant must be excluded
    const p = collectProxiesFromDb(db, PP);
    expect(p.changeCount).toBe(3);
    expect(p.distinctFilesEdited).toBe(2);
    expect(p.sameFileEditsMax).toBe(2);
  });

  it('counts only warn rows from detection_log', () => {
    const ins = db.prepare('INSERT INTO detection_log (project_path, decision) VALUES (?, ?)');
    ins.run(PP, 'warn'); ins.run(PP, 'warn'); ins.run(PP, 'none');
    expect(collectProxiesFromDb(db, PP).cycleWarnCount).toBe(2);
  });

  it('aggregates note_events by type', () => {
    const ins = db.prepare('INSERT INTO note_events (project_path, event_type) VALUES (?, ?)');
    ins.run(PP, 'surfaced'); ins.run(PP, 'layered'); ins.run(PP, 'surfaced');
    const p = collectProxiesFromDb(db, PP);
    expect(p.noteEvents.surfaced).toBe(2);
    expect(p.noteEvents.layered).toBe(1);
  });

  it('returns zeros for an empty project', () => {
    const p = collectProxiesFromDb(db, PP);
    expect(p.changeCount).toBe(0);
    expect(p.sameFileEditsMax).toBe(0);
    expect(p.cycleWarnCount).toBe(0);
  });
});
