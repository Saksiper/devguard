import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyContinent, classifyContinentDetailed } = require('../../src/engine/feature-classifier');
const { CONTINENTS } = require('../../src/engine/node-taxonomy');

describe('classifyContinent — model-free continent heuristic', () => {
  // [filePath, text, expectedContinent] — >= 1 case per continent + precedence.
  const cases = [
    ['src/foo.test.js', 'unit test for foo', 'test'],
    ['tests/unit/thing.js', 'a helper used in tests', 'test'],
    // precedence: a .tsx test file is TEST, not ui_ux
    ['components/Button.test.tsx', 'render the button and assert', 'test'],
    ['README.md', 'project readme', 'docs'],
    // precedence: docs beats security — a .md about auth is still docs
    ['docs/auth-guide.md', 'how login and token refresh works', 'docs'],
    ['Dockerfile', 'build the image', 'infra'],
    ['k8s/deploy.yaml', 'deployment manifest', 'infra'],
    // precedence: auth.js is security
    ['src/auth.js', 'sign the user in', 'security'],
    ['services/user.js', 'validate the jwt token', 'security'],
    ['db/migrate.js', 'run the database migration', 'data'],
    ['queries/report.js', 'run a sql query against the table', 'data'],
    ['components/Modal.jsx', 'a dialog box', 'ui_ux'],
    ['src/list.js', 'render the filter button', 'ui_ux'],
    ['lib/matrix.js', 'multiply the matrix', 'math'],
    ['src/helpers.js', 'combine the parts together', 'logic'],
    // ambiguous / no signal -> logic fallback
    ['src/misc.js', 'do the thing and return it', 'logic'],
  ];

  it('has at least 12 continent cases covering every continent', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const covered = new Set(cases.map((c) => c[2]));
    for (const c of CONTINENTS) expect(covered.has(c)).toBe(true);
  });

  for (const [filePath, text, expected] of cases) {
    it(`${filePath} + "${text}" -> ${expected}`, () => {
      expect(classifyContinent(filePath, text)).toBe(expected);
    });
  }

  it('every classification is a valid continent', () => {
    for (const [filePath, text] of cases) {
      expect(CONTINENTS).toContain(classifyContinent(filePath, text));
    }
  });

  it('precedence: x.test.tsx -> test (NOT ui_ux)', () => {
    expect(classifyContinent('src/widget.test.tsx', 'render widget')).toBe('test');
  });

  it('precedence: .md -> docs (NOT security even with auth text)', () => {
    expect(classifyContinent('notes/auth.md', 'jwt oauth login token')).toBe('docs');
  });

  it('auth.js -> security', () => {
    expect(classifyContinent('src/auth.js', '')).toBe('security');
  });

  it('handles empty / null inputs without throwing (-> logic)', () => {
    expect(classifyContinent('', '')).toBe('logic');
    expect(classifyContinent(null, null)).toBe('logic');
    expect(classifyContinent(undefined, undefined)).toBe('logic');
  });
});

describe('classifyContinentDetailed — seed keyword derivation', () => {
  it('returns the matched semantic keyword for seeding (security)', () => {
    const { continent, keyword } = classifyContinentDetailed('src/user.js', 'refresh the access token');
    expect(continent).toBe('security');
    expect(keyword).toBe('token');
  });

  it('falls back to null keyword for the logic fallback', () => {
    const { continent, keyword } = classifyContinentDetailed('src/misc.js', 'combine parts');
    expect(continent).toBe('logic');
    expect(keyword).toBeNull();
  });
});

describe('HARD rule: no model load reachable from read-path hooks', () => {
  // pre-edit MAY import findSimilarPairs (pure math on pre-computed vectors) but must
  // NEVER call loadModel/encode; user-prompt-submit must not touch embeddings at all.
  const readPathHooks = ['pre-edit.js', 'user-prompt-submit.js'];

  for (const hook of readPathHooks) {
    it(`${hook} never references loadModel`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../../src/hooks', hook), 'utf8');
      expect(src).not.toContain('loadModel');
    });
  }

  // S2.B made a model-load path REACHABLE from user-prompt-submit (embedding argmax),
  // but ONLY when sphere_read_resolver_enabled is true. The invariant is therefore no
  // longer "never touches embeddings" but "the model-load module (embedding-node-
  // resolver, which calls loadModel) is required LAZILY, only behind the config gate,
  // so DEFAULT-OFF has zero eager reach to a model load". A plain string-not-contains
  // check missed this — the require is one hop away and the string differs — so assert
  // transitive reachability against the REAL require graph instead.
  it('does not EAGERLY reach the embedding resolver (the model-load path is lazy behind the gate)', () => {
    const resolverPath = require.resolve('../../src/engine/embedding-node-resolver');
    const hookPath = require.resolve('../../src/hooks/user-prompt-submit.js');
    delete require.cache[resolverPath];
    delete require.cache[hookPath];

    require(hookPath); // main() does NOT run here (require.main !== this module)
    // If the resolver require were hoisted to module scope, loading the hook would
    // register it in the cache — exactly the regression the string check missed.
    expect(require.cache[resolverPath]).toBeUndefined();

    // Positive control: the resolver DOES register once actually required, proving
    // this assertion has teeth (it would catch an eager / top-level require).
    require(resolverPath);
    expect(require.cache[resolverPath]).toBeDefined();
  });

  it('the resolver (and thus loadModel) is reachable ONLY behind sphere_read_resolver_enabled — intentional, latency-gated', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/hooks/user-prompt-submit.js'), 'utf8');
    // The flag intentionally makes a model load reachable (embedding argmax)...
    expect(src).toContain("require('../engine/embedding-node-resolver')");
    // ...but the require sits AFTER the config gate, never at module top level.
    const gateIdx = src.indexOf('sphere_read_resolver_enabled');
    const reqIdx = src.indexOf("require('../engine/embedding-node-resolver')");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(reqIdx).toBeGreaterThan(gateIdx);
    // The hook module itself still never names loadModel or the classifier directly.
    expect(src).not.toContain('loadModel');
    expect(src).not.toContain('feature-classifier');
  });
});
