import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseConsistencyOutput } = require('../../tools/dg-ab-runner');

// Instrument validation for every sphere task in the bank: the hidden functional
// test must be ARM-NEUTRAL (both reference styles pass it) and the hidden
// consistency checker must be FULLY DIFFERENTIAL (minimal reference — the laziest
// correct implementation, never saw the decisions — scores 0; the note-compliant
// reference scores full). This is the mechanical guarantee that a passive-arm
// loss means "didn't know the decisions", not "wrote broken code" — and that the
// decisions aren't trivially satisfied (the first haiku smoke's prohibition-style
// constraints died exactly that way: passive scored 3/3 and everything tied).

const ROOT = __dirname;
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks.json'), 'utf8'));
const sphereTasks = bank.tasks.filter((t) => t.mode === 'sphere');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function run(cwd, cmd) {
  return spawnSync(cmd, { cwd, encoding: 'utf8', timeout: 20000, shell: true });
}

for (const task of sphereTasks) {
  describe(`refs differential: ${task.id}`, () => {
    const refsDir = path.join(ROOT, 'refs', task.id);
    let tmp;
    beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dg-refs-${task.id}-`)); });
    afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('ships minimal + compliant reference implementations', () => {
      expect(fs.existsSync(path.join(refsDir, 'minimal')), `${task.id}: refs/minimal missing`).toBe(true);
      expect(fs.existsSync(path.join(refsDir, 'compliant')), `${task.id}: refs/compliant missing`).toBe(true);
    });

    for (const style of ['minimal', 'compliant']) {
      it(`${style}: passes the hidden functional test (arm-neutral)`, () => {
        const dir = path.join(tmp, style);
        copyDir(path.join(ROOT, task.fixtureDir), dir);
        copyDir(path.join(refsDir, style), dir); // overlay the reference impl
        const r = run(dir, task.test.cmd);
        expect(r.status, `${task.id}/${style} functional: ${r.stdout}\n${r.stderr}`).toBe(0);
      }, 30000);

      it(`${style}: consistency score is ${style === 'minimal' ? '0 (fails every decision)' : 'full (follows every decision)'}`, () => {
        const dir = path.join(tmp, style); // already built by the functional test above
        const r = run(dir, task.consistencyTest.cmd);
        const parsed = parseConsistencyOutput(r.stdout || '');
        expect(parsed.total, `${task.id}/${style}: checker printed no CHECK lines: ${r.stdout}\n${r.stderr}`).toBeGreaterThanOrEqual(3);
        if (style === 'minimal') {
          expect(parsed.score, `${task.id}: minimal impl satisfied a decision — weak instrument: ${r.stdout}`).toBe(0);
        } else {
          expect(parsed.score, `${task.id}: compliant impl violated a decision: ${r.stdout}`).toBe(parsed.total);
        }
      }, 30000);
    }
  });
}
