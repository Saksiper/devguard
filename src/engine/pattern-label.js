'use strict';

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would',
  'could', 'should', 'error', 'failed', 'undefined', 'null', 'true', 'false',
  'function', 'const', 'var', 'let', 'return', 'import', 'export', 'require',
]);

function findCommonWords(texts) {
  if (!texts || texts.length < 2) return [];

  const wordSets = texts.map(t =>
    new Set(
      String(t).toLowerCase()
        .split(/[\s\p{P}\p{S}]+/u)
        .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    )
  );

  let common = new Set(wordSets[0]);
  for (let i = 1; i < wordSets.length; i++) {
    common = new Set([...common].filter(w => wordSets[i].has(w)));
  }

  return [...common].slice(0, 3);
}

function generatePatternLabel(texts) {
  const common = findCommonWords(texts);
  if (common.length > 0) {
    return `'${common.join(' + ')}' yaklasimi`;
  }
  return 'benzer yaklasim';
}

module.exports = { findCommonWords, generatePatternLabel };
