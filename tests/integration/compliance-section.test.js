import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const STATS_PATH = path.resolve(__dirname, '../../src/cli/stats.js');
const DOGFOOD_PATH = path.resolve(__dirname, '../../src/cli/dogfood.js');
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/compliance');

let tmpDir, projectDir;

function loadDb() {
  delete require.cache[require.resolve('../../src/engine/db')];
  delete require.cache[require.resolve('../../src/engine/sanitize')];
  delete require.cache[require.resolve('../../src/engine/debug-log')];
  return require('../../src/engine/db');
}

function loadSection() {
  delete require.cache[require.resolve('../../src/cli/compliance-section')];
  return require('../../src/cli/compliance-section');
}

function runCli(cliPath, args) {
  try {
    const stdout = execFileSync('node', [cliPath, ...args], {
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir, DEVGUARD_DEBUG: '0' },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-compliance-data-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-compliance-proj-'));
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

const { parseAckTags } = require('../../src/engine/dg-note');

// ─── Replay one canned JSONL transcript into the DB via the real compliance API ──
// surface → insertNote + insertNoteEvent('surfaced'); supersede → insertNote +
// supersedePriorHead; reply → parseAckTags + ackNoteCompliance (the Stop-hook ack
// harvest, minus the transcript file); finalize → finalizeNoteCompliance (SessionEnd).
// This is the exact chain the hooks drive in production.
function replayFixture(db, name, lines) {
  const session = 'sess-' + name;
  const surfaced = [];
  for (const l of lines) {
    if (l.kind === 'surface') {
      const id = db.insertNote({
        file: l.node_id, node_id: l.node_id, source: 'yol2_claude',
        confidence_level: 3, note_text: l.note_text, session_id: session,
      });
      db.insertNoteEvent({ note_id: id, session_id: session, event_type: 'surfaced' });
      surfaced.push({ id, node_id: l.node_id, expect: l.expect });
    } else if (l.kind === 'supersede') {
      const newId = db.insertNote({
        file: l.node_id, node_id: l.node_id, source: 'yol2_claude',
        confidence_level: 3, note_text: l.note_text, session_id: session,
      });
      db.supersedePriorHead(l.node_id, newId);
    } else if (l.kind === 'reply') {
      for (const tag of parseAckTags(l.text || '')) {
        db.ackNoteCompliance(session, { outcome: tag.outcome, nodeId: tag.nodeToken || null, reason: tag.reason });
      }
    } else if (l.kind === 'finalize') {
      db.finalizeNoteCompliance(session);
    }
  }
  return { session, surfaced };
}

function loadFixtures() {
  const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.jsonl')).sort();
  return files.map(f => ({
    name: path.basename(f, '.jsonl'),
    lines: fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l)),
  }));
}

// ─── A. buildComplianceSection formatting (controlled numbers) ──────────────────

describe('buildComplianceSection — formatting', () => {
  it('returns [] on an empty DB (no compliance data, no notes)', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const { buildComplianceSection } = loadSection();
    expect(buildComplianceSection(proxy, {})).toEqual([]);
  });

  it('renders exact compliance rate, counts, surfaced %, and avg layer depth', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const n1 = proxy.insertNote({ file: 'x', node_id: 'ui_ux/filter', source: 's', confidence_level: 3, note_text: 'x', session_id: 's1' });
    const n2 = proxy.insertNote({ file: 'y', node_id: 'ui_ux/search', source: 's', confidence_level: 3, note_text: 'y', session_id: 's1' });
    // n1 re-surfaced within s1 (counts once) and surfaced in s2; n2 surfaced in s1.
    proxy.insertNoteEvent({ note_id: n1, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n1, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n1, session_id: 's2', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n2, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n1, session_id: 's1', event_type: 'complied' });
    proxy.insertNoteEvent({ note_id: n1, session_id: 's2', event_type: 'complied' });
    proxy.insertNoteEvent({ note_id: n2, session_id: 's1', event_type: 'ignored' });

    const { buildComplianceSection } = loadSection();
    const out = buildComplianceSection(proxy, {}).join('\n');
    expect(out).toContain('### Note Compliance (sphere)');
    expect(out).toMatch(/Compliance rate \| 66\.7%/);   // 2 / (2+1)
    expect(out).toMatch(/Complied \| 2/);
    expect(out).toMatch(/Ignored \| 1/);
    expect(out).toMatch(/Superseded \| 0/);
    expect(out).toMatch(/Surfaced \| 3/);               // distinct (note, session) pairs
    expect(out).toMatch(/Complied of surfaced \| 66\.7%/); // 2 / 3
    expect(out).toMatch(/Avg layer depth \| 1\.00/);       // one note per node
  });

  it('shows "—" (not 0.0%) for the rate rows when nothing has been decided yet', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    // A note surfaced (twice, same session → one opportunity) but nothing decided.
    const n = proxy.insertNote({ file: 'x', node_id: 'ui_ux/filter', source: 's', confidence_level: 3, note_text: 'x', session_id: 's1' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'surfaced' });
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'surfaced' });

    const { buildComplianceSection } = loadSection();
    const out = buildComplianceSection(proxy, {}).join('\n');
    expect(out).toContain('### Note Compliance (sphere)');
    // Factual counts still render.
    expect(out).toMatch(/Surfaced \| 1/);
    // Rate rows must NOT misreport "no data" as 0% ignored.
    expect(out).not.toMatch(/Compliance rate \| 0\.0%/);
    expect(out).toMatch(/Compliance rate \| — /);
    expect(out).toMatch(/Complied of surfaced \| — /);
  });

  it('a notes-but-no-events project does not emit a zero-valued compliance table', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    // A note placed on a node, but nothing surfaced/decided → total === 0.
    proxy.insertNote({ file: 'x', node_id: 'ui_ux/filter', source: 's', confidence_level: 3, note_text: 'x', session_id: 's1' });

    const { buildComplianceSection } = loadSection();
    const out = buildComplianceSection(proxy, {}).join('\n');
    expect(out).toContain('### Note Compliance (sphere)');
    // No misleading zero-valued compliance rows.
    expect(out).not.toMatch(/Compliance rate \| 0\.0%/);
    expect(out).not.toMatch(/Complied \| 0/);
    // Avg layer depth (the only real datum) still shows.
    expect(out).toMatch(/Avg layer depth \| 1\.00/);
  });

  it('omits the Avg layer depth row when no node-scoped notes exist', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const n = proxy.insertNote({ file: 'x', source: 's', confidence_level: 3, note_text: 'x', session_id: 's1' }); // node_id null
    proxy.insertNoteEvent({ note_id: n, session_id: 's1', event_type: 'complied' });
    const { buildComplianceSection } = loadSection();
    const out = buildComplianceSection(proxy, {}).join('\n');
    expect(out).toContain('### Note Compliance (sphere)');
    expect(out).not.toContain('Avg layer depth');
  });
});

// ─── B. 20 canned JSONL fixtures → deterministic compliance numbers ─────────────

describe('compliance fixtures — end-to-end DB numbers', () => {
  it('exercises ~20 synthetic transcripts and matches expected complied/ignored/superseded', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(20);

    const expected = { complied: 0, ignored: 0, superseded: 0, surfaced: 0 };
    const allNotes = [];
    for (const fx of fixtures) {
      const { surfaced } = replayFixture(proxy, fx.name, fx.lines);
      for (const s of surfaced) {
        expected[s.expect] += 1;
        expected.surfaced += 1;
        allNotes.push(s);
      }
    }

    // Per-note: the mechanism classified each surfaced note exactly as its fixture labels it.
    for (const s of allNotes) {
      const events = proxy.getNoteEvents({ note_id: s.id })
        .filter(e => ['complied', 'ignored', 'superseded'].includes(e.event_type));
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe(s.expect);
    }

    // Aggregate: getNoteComplianceStats over the whole project.
    const stats = proxy.getNoteComplianceStats({});
    expect(stats.surfaced).toBe(expected.surfaced);
    expect(stats.complied).toBe(expected.complied);
    expect(stats.ignored).toBe(expected.ignored);
    expect(stats.superseded).toBe(expected.superseded);
    expect(stats.compliance).toBeCloseTo(expected.complied / (expected.complied + expected.ignored), 6);
    expect(stats.compliance_of_surfaced).toBeCloseTo(expected.complied / expected.surfaced, 6);

    // Corpus must actually cover all three outcomes (not a degenerate all-complied set).
    expect(expected.complied).toBeGreaterThan(0);
    expect(expected.ignored).toBeGreaterThan(0);
    expect(expected.superseded).toBeGreaterThan(0);
  });

  it('sanitizes secrets and preserves Turkish text written by the fixtures', () => {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    for (const fx of loadFixtures()) replayFixture(proxy, fx.name, fx.lines);

    const notes = proxy.getNotes({ limit: 10000 });
    const secretNote = notes.find(n => n.node_id === 'config/keys');
    expect(secretNote.note_text).toContain('[REDACTED_API_KEY]');
    expect(secretNote.note_text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');

    const trNote = notes.find(n => n.node_id === 'security/sifre');
    expect(trNote.note_text).toContain('Girişte token süresi korunmalı');
  });
});

// ─── C. CLI rendering of the fixture-driven numbers ─────────────────────────────

describe('CLI compliance section — fixture-driven', () => {
  function seedAllFixtures() {
    const db = loadDb();
    const proxy = db.getDb(projectDir);
    const expected = { complied: 0, ignored: 0, superseded: 0, surfaced: 0 };
    for (const fx of loadFixtures()) {
      const { surfaced } = replayFixture(proxy, fx.name, fx.lines);
      for (const s of surfaced) { expected[s.expect] += 1; expected.surfaced += 1; }
    }
    db.closeDb();
    return expected;
  }

  it('stats.js renders the Note Compliance section with fixture numbers', () => {
    const e = seedAllFixtures();
    const res = runCli(STATS_PATH, ['--project', projectDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('### Note Compliance (sphere)');
    expect(res.stdout).toContain(`| Complied | ${e.complied} |`);
    expect(res.stdout).toContain(`| Ignored | ${e.ignored} |`);
    expect(res.stdout).toContain(`| Superseded | ${e.superseded} |`);
    expect(res.stdout).toContain(`| Surfaced | ${e.surfaced} |`);
    const rate = (e.complied / (e.complied + e.ignored) * 100).toFixed(1);
    expect(res.stdout).toContain(`| Compliance rate | ${rate}% |`);
  });

  it('dogfood.js --report renders the Note Compliance section with fixture numbers', () => {
    const e = seedAllFixtures();
    const res = runCli(DOGFOOD_PATH, ['--project', projectDir, '--report']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('### Note Compliance (sphere)');
    expect(res.stdout).toContain(`| Complied | ${e.complied} |`);
    const surfPct = (e.complied / e.surfaced * 100).toFixed(1);
    expect(res.stdout).toContain(`| Complied of surfaced | ${surfPct}% |`);
  });

  it('stats.js on an empty DB omits the compliance section entirely', () => {
    const db = loadDb();
    db.getDb(projectDir);
    db.closeDb();
    const res = runCli(STATS_PATH, ['--project', projectDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('Note Compliance');
  });
});
