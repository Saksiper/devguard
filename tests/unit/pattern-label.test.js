import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findCommonWords, generatePatternLabel } = require('../../src/engine/pattern-label');

describe('findCommonWords', () => {
  it('extracts common words from similar texts', () => {
    const texts = [
      'fix timeout by increasing interval',
      'resolve timeout issue with larger interval',
    ];
    const common = findCommonWords(texts);
    expect(common).toContain('timeout');
    expect(common).toContain('interval');
  });

  it('returns empty for empty list', () => {
    expect(findCommonWords([])).toEqual([]);
  });

  it('returns empty for null', () => {
    expect(findCommonWords(null)).toEqual([]);
  });

  it('returns empty for single text', () => {
    expect(findCommonWords(['only one'])).toEqual([]);
  });

  it('filters stop words', () => {
    const texts = [
      'the function should return true',
      'this function would return false',
    ];
    const common = findCommonWords(texts);
    expect(common).not.toContain('function');
    expect(common).not.toContain('return');
    expect(common).not.toContain('true');
    expect(common).not.toContain('false');
  });

  it('filters short words (<=3 chars)', () => {
    const texts = [
      'fix the bug in app code',
      'fix the bug in lib code',
    ];
    const common = findCommonWords(texts);
    expect(common).not.toContain('fix');
    expect(common).not.toContain('the');
    expect(common).not.toContain('bug');
    expect(common).not.toContain('in');
    expect(common).toContain('code');
  });

  it('limits to 3 words', () => {
    const texts = [
      'alpha bravo charlie delta echo foxtrot',
      'alpha bravo charlie delta echo foxtrot',
    ];
    const common = findCommonWords(texts);
    expect(common.length).toBeLessThanOrEqual(3);
  });

  it('handles 3+ texts (intersection of all)', () => {
    const texts = [
      'timeout error during connection',
      'timeout issue while connecting',
      'timeout problem with connection retry',
    ];
    const common = findCommonWords(texts);
    expect(common).toContain('timeout');
  });

  it('returns empty when no common words', () => {
    const texts = [
      'alpha bravo charlie',
      'delta echo foxtrot',
    ];
    expect(findCommonWords(texts)).toEqual([]);
  });
});

describe('generatePatternLabel', () => {
  it('generates label from common words', () => {
    const texts = [
      'fix timeout by increasing interval',
      'resolve timeout issue with larger interval',
    ];
    const label = generatePatternLabel(texts);
    expect(label).toContain('timeout');
    expect(label).toContain('yaklasimi');
  });

  it('returns fallback when no common words', () => {
    const texts = ['alpha bravo', 'delta echo'];
    expect(generatePatternLabel(texts)).toBe('benzer yaklasim');
  });

  it('returns fallback for empty list', () => {
    expect(generatePatternLabel([])).toBe('benzer yaklasim');
  });

  it('handles non-string inputs gracefully', () => {
    const texts = [null, undefined, 123];
    expect(generatePatternLabel(texts)).toBe('benzer yaklasim');
  });
});

describe('findCommonWords — Turkish character support', () => {
  it('preserves Turkish characters in words', () => {
    const texts = [
      'bağlantı zaman aşımı hatası',
      'bağlantı zaman aşımı sorunu',
    ];
    const common = findCommonWords(texts);
    expect(common).toContain('bağlantı');
    expect(common).toContain('aşımı');
    expect(common).toContain('zaman');
  });

  it('does not split Turkish words at ş, ö, ç, ğ, ü, ı boundaries', () => {
    const texts = [
      'değişiklik öğesi çözümü',
      'değişiklik öğesi güncellemesi',
    ];
    const common = findCommonWords(texts);
    expect(common).toContain('değişiklik');
    expect(common).toContain('öğesi');
  });

  it('generates Turkish label correctly', () => {
    const texts = [
      'bağlantı hatası düzeltme',
      'bağlantı hatası çözme',
    ];
    const label = generatePatternLabel(texts);
    expect(label).toContain('bağlantı');
    expect(label).toContain('yaklasimi');
  });
});
