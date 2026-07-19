import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveNodeId, KEYWORD_MAP } = require('../../src/engine/keyword-node-map');
const { isValidNodeId } = require('../../src/engine/node-taxonomy');

describe('keyword-node-map — resolveNodeId', () => {
  it('matches English keywords', () => {
    expect(resolveNodeId('add a filter to the list')).toBe('ui_ux/filter');
    expect(resolveNodeId('implement login flow')).toBe('security/auth');
    expect(resolveNodeId('build a search bar')).toBe('ui_ux/search');
  });

  it('matches Turkish keywords', () => {
    expect(resolveNodeId('listeye filtre ekle')).toBe('ui_ux/filter');
    expect(resolveNodeId('arama kutusu yap')).toBe('ui_ux/search');
  });

  it('matches auth keyword', () => {
    expect(resolveNodeId('refactor the auth module')).toBe('security/auth');
  });

  it('is case-insensitive', () => {
    expect(resolveNodeId('ADD A FILTER')).toBe('ui_ux/filter');
    expect(resolveNodeId('LOGIN page')).toBe('security/auth');
  });

  it('returns null when no keyword matches', () => {
    expect(resolveNodeId('refactor database migrations')).toBeNull();
    expect(resolveNodeId('')).toBeNull();
  });

  it('returns the first matching keyword when multiple are present', () => {
    // 'filter' appears before 'login' in the text
    expect(resolveNodeId('add a filter then a login form')).toBe('ui_ux/filter');
    // 'login' appears before 'search' in the text
    expect(resolveNodeId('login first then search')).toBe('security/auth');
  });

  it('does not match keywords inside larger words (word boundary)', () => {
    expect(resolveNodeId('we need authority checks')).toBeNull();
    expect(resolveNodeId('researching the codebase')).toBeNull();
  });

  it('every KEYWORD_MAP value is a valid node_id', () => {
    const values = Object.values(KEYWORD_MAP);
    expect(values.length).toBeGreaterThan(0);
    for (const nodeId of values) {
      expect(isValidNodeId(nodeId)).toBe(true);
    }
  });
});
