import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DOGFOOD_PATH = path.resolve(__dirname, '../../src/cli/dogfood.js');

let tmpDir, projectDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function runDogfood(args) {
  try {
    const stdout = execFileSync('node', [DOGFOOD_PATH, ...args], {
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0' },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-dogfood-'));
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

// ─── Unit: parseArgs + computeMetrics ────────────────────────────

describe('parseArgs', () => {
  it('parses all flags', () => {
    const { parseArgs } = require('../../src/cli/dogfood');
    const args = parseArgs(['node', 'dogfood.js', '--project', '/p', '--list', '--session']);
    expect(args.project).toBe('/p');
    expect(args.list).toBe(true);
    expect(args.session).toBe(true);
  });

  it('parses classify flags', () => {
    const { parseArgs } = require('../../src/cli/dogfood');
    const args = parseArgs(['node', 'dogfood.js', '--project', '/p', '--classify', '5', '--as', 'tp', '--note', 'ok']);
    expect(args.classify).toBe(5);
    expect(args.as).toBe('tp');
    expect(args.note).toBe('ok');
  });
});

describe('computeMetrics', () => {
  it('computes precision, recall', () => {
    const { computeMetrics } = require('../../src/cli/dogfood');
    const m = computeMetrics({ total: 10, tp: 6, fp: 2, fn: 1, unclassified: 1 });
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(6 / 7);
  });

  it('handles zero division', () => {
    const { computeMetrics } = require('../../src/cli/dogfood');
    const m = computeMetrics({ total: 0, tp: 0, fp: 0, fn: 0, unclassified: 0 });
    expect(m.precision).toBe(0);
    expect(m.recall).toBe(0);
  });
});

// ─── CLI subprocess tests ────────────────────────────────────────

describe('CLI: --list', () => {
  it('returns empty list when no detections', () => {
    const { getDb, closeDb } = loadDb();
    getDb(projectDir).insertSession('s1');
    closeDb();

    const result = runDogfood(['--project', projectDir, '--list', '--session']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(0);
    expect(output.unclassified).toEqual([]);
  });

  it('lists unclassified detections', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');
    db.insertDetection({ session_id: 's1', file: 'app.js', decision: 'warn', level: 1, type: 'file_match', message: 'test' });
    db.insertDetection({ session_id: 's1', file: 'db.js', decision: 'block', level: 2, type: 'diff_match', message: 'block' });
    closeDb();

    const result = runDogfood(['--project', projectDir, '--list', '--session']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(2);
    expect(output.unclassified[0].decision).toBe('block');
    expect(output.unclassified[1].decision).toBe('warn');
  });

  it('excludes already classified', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertSession('s1');
    const id = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'block' });
    db.classifyDetection(id, 'tp', null);
    closeDb();

    const result = runDogfood(['--project', projectDir, '--list', '--session']);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(1);
    expect(output.unclassified[0].file).toBe('b.js');
  });
});

describe('CLI: --classify', () => {
  it('classifies a detection as tp', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    closeDb();

    const result = runDogfood(['--project', projectDir, '--classify', String(id), '--as', 'tp', '--note', 'hakli uyari']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.classification).toBe('tp');
  });

  it('rejects invalid classification', () => {
    const result = runDogfood(['--project', projectDir, '--classify', '1', '--as', 'invalid']);
    expect(result.exitCode).toBe(1);
  });

  it('fails for non-existent id', () => {
    const { getDb, closeDb } = loadDb();
    getDb(projectDir);
    closeDb();

    const result = runDogfood(['--project', projectDir, '--classify', '9999', '--as', 'tp']);
    expect(result.exitCode).toBe(1);
  });
});

describe('CLI: --add-fn', () => {
  it('adds a false negative record', () => {
    const { getDb, closeDb } = loadDb();
    getDb(projectDir).insertSession('s1');
    closeDb();

    const result = runDogfood(['--project', projectDir, '--add-fn', '--session', '--note', 'Dongudeydim ama yakalamadi']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.classification).toBe('fn');
  });

  it('requires --note', () => {
    const result = runDogfood(['--project', projectDir, '--add-fn']);
    expect(result.exitCode).toBe(1);
  });
});

describe('CLI: --report', () => {
  it('generates markdown report', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    const id1 = db.insertDetection({ session_id: 's1', file: 'a.js', decision: 'warn' });
    const id2 = db.insertDetection({ session_id: 's1', file: 'b.js', decision: 'block' });
    db.insertDetection({ session_id: 's1', file: 'c.js', decision: 'warn' });
    db.classifyDetection(id1, 'tp', null);
    db.classifyDetection(id2, 'fp', null);
    closeDb();

    const result = runDogfood(['--project', projectDir, '--report']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Dogfood Report');
    expect(result.stdout).toContain('True Positive');
    expect(result.stdout).toContain('Precision');
  });

  it('shows guidance for empty DB', () => {
    const { getDb, closeDb } = loadDb();
    getDb(projectDir);
    closeDb();

    const result = runDogfood(['--project', projectDir, '--report']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No detection_log records yet');
  });
});

describe('CLI: --notes', () => {
  it('filters notes by --source', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertNote({ file: 'a.js', source: 'yol4', confidence_level: 2, note_text: 'from yol4' });
    db.insertNote({ file: 'b.js', source: 'sphere', confidence_level: 3, note_text: 'from sphere' });
    closeDb();

    const result = runDogfood(['--project', projectDir, '--notes', '--source', 'yol4']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(1);
    expect(output.notes[0].source).toBe('yol4');
  });

  it('returns all notes when --source is omitted', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertNote({ file: 'a.js', source: 'yol4', confidence_level: 2, note_text: 'from yol4' });
    db.insertNote({ file: 'b.js', source: 'sphere', confidence_level: 3, note_text: 'from sphere' });
    closeDb();

    const result = runDogfood(['--project', projectDir, '--notes']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(2);
  });

  it('filters notes by --node-prefix', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertNote({ file: 'a.js', source: 'yol4', confidence_level: 2, note_text: 'ui note', node_id: 'ui_ux/filter' });
    db.insertNote({ file: 'b.js', source: 'yol4', confidence_level: 2, note_text: 'security note', node_id: 'security/auth' });
    closeDb();

    const result = runDogfood(['--project', projectDir, '--notes', '--node-prefix', 'ui_ux/']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(1);
    expect(output.notes[0].note_text).toBe('ui note');
  });

  it('combines --source and --node-prefix', () => {
    const { getDb, closeDb } = loadDb();
    const db = getDb(projectDir);
    db.insertNote({ file: 'a.js', source: 'yol4', confidence_level: 2, note_text: 'ui yol4', node_id: 'ui_ux/filter' });
    db.insertNote({ file: 'b.js', source: 'yol4', confidence_level: 2, note_text: 'security yol4', node_id: 'security/auth' });
    db.insertNote({ file: 'a.js', source: 'sphere', confidence_level: 2, note_text: 'ui sphere', node_id: 'ui_ux/sort' });
    closeDb();

    // --source alone would match 2 rows (ui yol4 + security yol4); only combining
    // with --node-prefix narrows it to 1 — proves both filters are actually applied.
    const result = runDogfood(['--project', projectDir, '--notes', '--source', 'yol4', '--node-prefix', 'ui_ux/']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.count).toBe(1);
    expect(output.notes[0].note_text).toBe('ui yol4');
  });
});

describe('CLI: no args', () => {
  it('shows usage and exits 1', () => {
    const result = runDogfood([]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Usage:');
  });
});
