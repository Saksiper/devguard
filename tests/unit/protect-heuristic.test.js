import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateProtectNote } = require('../../src/engine/protect-heuristic');

describe('generateProtectNote — file-type rules', () => {
  it('returns null for ordinary code file with no diff signal', () => {
    const note = generateProtectNote({
      filePath: 'src/foo/bar.js',
      action: 'Edit',
      newCode: 'const x = 1;',
      oldCode: 'const x = 0;',
    });
    expect(note).toBeNull();
  });

  it('warns on test files', () => {
    const note = generateProtectNote({
      filePath: 'tests/unit/db.test.js',
      action: 'Edit',
      newCode: 'expect(x).toBe(1)',
      oldCode: 'expect(x).toBe(0)',
    });
    expect(note).toMatch(/[Tt]est file/);
  });

  it('warns on .spec. naming', () => {
    const note = generateProtectNote({
      filePath: 'src/foo.spec.ts',
      action: 'Edit',
      newCode: 'it("x", () => {})',
      oldCode: '',
    });
    expect(note).toMatch(/[Tt]est file/);
  });

  it('warns on DevGuard hooks', () => {
    const note = generateProtectNote({
      filePath: 'src/hooks/post-edit.js',
      action: 'Edit',
      newCode: 'respond({})',
      oldCode: '',
    });
    expect(note).toMatch(/[Hh]ook/);
    expect(note).toMatch(/exit/);
  });

  it('warns on schema-touching db.js edits', () => {
    const note = generateProtectNote({
      filePath: 'src/engine/db.js',
      action: 'Edit',
      newCode: 'CREATE TABLE foo (id INTEGER)',
      oldCode: '',
    });
    expect(note).toMatch(/[Ss]chema/);
    expect(note).toMatch(/version/);
  });

  it('does NOT warn on non-schema db.js edits', () => {
    const note = generateProtectNote({
      filePath: 'src/engine/db.js',
      action: 'Edit',
      newCode: 'const helper = computeHelper(input);',
      oldCode: 'const helper = legacyHelper(input);',
    });
    // A db.js edit with no schema keywords must not trigger the schema rule
    // (and need not produce any note at all).
    expect(note === null || !/[Ss]chema/.test(note)).toBe(true);
  });

  it('warns on yaml configs', () => {
    const note = generateProtectNote({
      filePath: 'devguard.config.yaml',
      action: 'Edit',
      newCode: 'threshold: 0.85',
      oldCode: 'threshold: 0.80',
    });
    expect(note).toMatch(/[Cc]onfig/);
  });

  it('warns on .env files', () => {
    const note = generateProtectNote({
      filePath: '.env',
      action: 'Edit',
      newCode: 'X=1',
      oldCode: 'X=0',
    });
    expect(note).toMatch(/[Cc]onfig/);
  });
});

describe('generateProtectNote — diff-content rules', () => {
  it('warns when try/catch added', () => {
    const note = generateProtectNote({
      filePath: 'src/foo.js',
      action: 'Edit',
      newCode: 'try { run(); } catch (e) { log(e); }',
      oldCode: 'run();',
    });
    expect(note).toMatch(/[Ee]rror handling added/);
  });

  it('warns when try/catch removed', () => {
    const note = generateProtectNote({
      filePath: 'src/foo.js',
      action: 'Edit',
      newCode: 'run();',
      oldCode: 'try { run(); } catch (e) { log(e); }',
    });
    expect(note).toMatch(/[Ee]rror handling removed/);
  });

  it('warns on TODO/FIXME marker added', () => {
    const note = generateProtectNote({
      filePath: 'src/foo.js',
      action: 'Edit',
      newCode: '// TODO: refactor\nconst x = 1;',
      oldCode: 'const x = 1;',
    });
    expect(note).toMatch(/TODO|FIXME/);
  });

  it('does NOT warn when TODO already existed in old code', () => {
    const note = generateProtectNote({
      filePath: 'src/foo.js',
      action: 'Edit',
      newCode: '// TODO: refactor\nconst x = 2;',
      oldCode: '// TODO: refactor\nconst x = 1;',
    });
    expect(note).toBeNull();
  });
});

describe('generateProtectNote — broadened business-logic rules (FINDING 4)', () => {
  it('flags a token-bucket refill diff (elapsed × refillRate with a clock read)', () => {
    const note = generateProtectNote({
      filePath: 'src/rate-limiter.js',
      action: 'Edit',
      newCode: [
        'const now = Date.now();',
        'const elapsed = now - this.lastRefill;',
        'this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);',
        'this.lastRefill = now;',
      ].join('\n'),
      oldCode: 'this.tokens = this.capacity;',
    });
    expect(note).not.toBeNull();
    expect(note).toMatch(/[Tt]ime-based calc/);
    expect(note).toMatch(/ms vs s/);
  });

  it('flags numeric clamp via Math.min/Math.max', () => {
    const note = generateProtectNote({
      filePath: 'src/score.js',
      action: 'Edit',
      newCode: 'return Math.max(0, Math.min(score, ceiling));',
      oldCode: 'return score;',
    });
    expect(note).toMatch(/[Nn]umeric bound/);
  });

  it('flags async/IO call when a fetch is added', () => {
    const note = generateProtectNote({
      filePath: 'src/client.js',
      action: 'Edit',
      newCode: 'const res = await fetch(url);',
      oldCode: 'const res = cache.get(url);',
    });
    expect(note).toMatch(/[Aa]sync\/IO/);
  });

  it('does NOT flag a plain method call like pool.run() as async/IO (FP fix)', () => {
    const note = generateProtectNote({
      filePath: 'src/worker.js',
      action: 'Edit',
      newCode: 'this.pool.run(job);',
      oldCode: 'runInline(job);',
    });
    expect(note === null || !/[Aa]sync\/IO/.test(note)).toBe(true);
  });

  it('flags an explicitly constructed RegExp (literal /.../ is ambiguous with division, so not matched)', () => {
    const note = generateProtectNote({
      filePath: 'src/parse.js',
      action: 'Edit',
      newCode: 'const re = new RegExp("^[a-z]+-\\\\d{3,}$", "i");',
      oldCode: 'const re = null;',
    });
    expect(note).toMatch(/[Rr]egex/);
  });

  it('does NOT flag plain division as a regex (FP fix)', () => {
    const note = generateProtectNote({
      filePath: 'src/math.js',
      action: 'Edit',
      newCode: 'const r = total / count / 2;',
      oldCode: 'const r = total;',
    });
    expect(note === null || !/[Rr]egex/.test(note)).toBe(true);
  });

  it('flags a one-line refill edit even when the clock read sits on an unchanged line (flagship)', () => {
    // Realistic incremental Edit: only the math line changes; the clock read
    // stays put on an unchanged line. The elapsed×rate idiom in the added line
    // must still fire (the AND-with-clock-read variant would miss this).
    const note = generateProtectNote({
      filePath: 'src/rate-limiter.js',
      action: 'Edit',
      oldCode: 'this.tokens = this.tokens + elapsed * this.refillRate;',
      newCode: 'this.tokens = this.tokens + (elapsed / 1000) * this.refillRate;',
    });
    expect(note).toMatch(/[Tt]ime-based calc/);
  });

  it('does NOT flag a bare numeric literal as a magic number (noise fix)', () => {
    const note = generateProtectNote({
      filePath: 'src/throttle.js',
      action: 'Edit',
      newCode: 'const ratio = 0.5;',
      oldCode: 'const ratio = compute();',
    });
    expect(note === null || !/[Mm]agic/.test(note)).toBe(true);
  });

  it('flags public API changes (module.exports)', () => {
    const note = generateProtectNote({
      filePath: 'src/api.js',
      action: 'Edit',
      newCode: 'module.exports = { run, stop };',
      oldCode: 'module.exports = { run };',
    });
    expect(note).toMatch(/[Pp]ublic API/);
  });

  it('flags public API changes (ESM export)', () => {
    const note = generateProtectNote({
      filePath: 'src/api.mjs',
      action: 'Edit',
      newCode: 'export function start(opts) {}',
      oldCode: 'function start() {}',
    });
    expect(note).toMatch(/[Pp]ublic API/);
  });

  it('still returns null for an ordinary trivial edit', () => {
    const note = generateProtectNote({
      filePath: 'src/util/format.js',
      action: 'Edit',
      newCode: 'return a - b;',
      oldCode: 'return a + b;',
    });
    expect(note).toBeNull();
  });
});

describe('generateProtectNote — combinations & limits', () => {
  it('joins multiple rules with " · "', () => {
    const note = generateProtectNote({
      filePath: 'src/hooks/post-edit.js',
      action: 'Edit',
      newCode: 'try { run(); } catch (e) { log(e); } // TODO: refine',
      oldCode: 'run();',
    });
    expect(note).toMatch(/[Hh]ook/);
    expect(note).toMatch(/[Ee]rror handling added/);
    expect(note.includes(' · ')).toBe(true);
  });

  it('emits at most 2 parts to avoid spam', () => {
    // hook file + try/catch added + clamp + magic number would be 4 parts;
    // only the top 2 should survive.
    const note = generateProtectNote({
      filePath: 'src/hooks/post-edit.js',
      action: 'Edit',
      newCode: 'try { x = Math.min(1000, y); } catch (e) { log(e); }',
      oldCode: 'x = y;',
    });
    expect(note).not.toBeNull();
    expect(note.split(' · ').length).toBeLessThanOrEqual(2);
  });

  it('truncates output above 200 chars', () => {
    const note = generateProtectNote({
      filePath: 'tests/unit/something.test.js',
      action: 'Edit',
      newCode: 'try { run(); } catch (e) { log(e); } // TODO: refine ' + 'x'.repeat(500),
      oldCode: 'run();',
    });
    expect(note).not.toBeNull();
    expect(note.length).toBeLessThanOrEqual(200);
  });

  it('handles missing/undefined inputs gracefully', () => {
    expect(generateProtectNote({})).toBeNull();
    expect(generateProtectNote()).toBeNull();
    expect(generateProtectNote({ filePath: null, newCode: null, oldCode: null })).toBeNull();
  });

  it('Windows-style paths normalize correctly', () => {
    const note = generateProtectNote({
      filePath: 'src\\hooks\\post-edit.js',
      action: 'Edit',
      newCode: '',
      oldCode: '',
    });
    expect(note).toMatch(/[Hh]ook/);
  });
});
