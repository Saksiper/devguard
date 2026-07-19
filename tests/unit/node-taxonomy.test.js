import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CONTINENTS, normalizeCountry, isValidNodeId } = require('../../src/engine/node-taxonomy');

describe('CONTINENTS', () => {
  it('is exactly the 8 expected strings in order', () => {
    expect(CONTINENTS).toEqual([
      'ui_ux', 'security', 'data', 'logic', 'infra', 'math', 'test', 'docs',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CONTINENTS)).toBe(true);
  });
});

describe('normalizeCountry', () => {
  it('lowercases input', () => {
    expect(normalizeCountry('FOO')).toBe('foo');
  });

  it('replaces a run of non-alphanumerics with a single dash', () => {
    expect(normalizeCountry('Search Filter')).toBe('search-filter');
  });

  it('collapses multiple separators into one dash', () => {
    expect(normalizeCountry('foo___bar   baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing separators', () => {
    expect(normalizeCountry('  Foo_Bar  ')).toBe('foo-bar');
  });

  it('keeps digits', () => {
    expect(normalizeCountry('v2 Engine')).toBe('v2-engine');
  });

  it('returns empty string for all-separator input', () => {
    expect(normalizeCountry('   ___   ')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeCountry('')).toBe('');
  });

  it('is idempotent on already-normalized input', () => {
    expect(normalizeCountry('search-filter')).toBe('search-filter');
  });
});

describe('isValidNodeId', () => {
  it('accepts a valid continent/country id', () => {
    expect(isValidNodeId('ui_ux/filter')).toBe(true);
  });

  it('rejects a non-normalized country', () => {
    expect(isValidNodeId('ui_ux/Search Filter')).toBe(false);
  });

  it('rejects an unknown continent', () => {
    expect(isValidNodeId('nope/x')).toBe(false);
  });

  it('rejects an empty country', () => {
    expect(isValidNodeId('ui_ux/')).toBe(false);
  });

  it('rejects an id with no slash', () => {
    expect(isValidNodeId('ui_ux')).toBe(false);
  });

  it('rejects an id with extra slashes', () => {
    expect(isValidNodeId('ui_ux/foo/bar')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidNodeId('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidNodeId(null)).toBe(false);
    expect(isValidNodeId(undefined)).toBe(false);
    expect(isValidNodeId(42)).toBe(false);
  });

  it('accepts every continent with a normalized country', () => {
    for (const c of CONTINENTS) {
      expect(isValidNodeId(`${c}/some-country`)).toBe(true);
    }
  });

  it('rejects an uppercase continent', () => {
    expect(isValidNodeId('UI_UX/filter')).toBe(false);
  });
});
