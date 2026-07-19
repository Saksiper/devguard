'use strict';

const KEYWORD_MAP = Object.freeze({
  filter: 'ui_ux/filter',
  filtre: 'ui_ux/filter',
  login: 'security/auth',
  auth: 'security/auth',
  search: 'ui_ux/search',
  arama: 'ui_ux/search',
});

function resolveNodeId(promptText) {
  if (typeof promptText !== 'string' || promptText.length === 0) return null;
  const lower = promptText.toLowerCase();
  let bestKeyword = null;
  let bestIndex = Infinity;
  for (const keyword of Object.keys(KEYWORD_MAP)) {
    // Word-boundary match so 'auth' does not fire on 'authority' and
    // 'search' does not fire on 'researching'. Keywords are fixed/safe.
    const m = lower.match(new RegExp(`\\b${keyword}\\b`));
    if (m && m.index < bestIndex) {
      bestIndex = m.index;
      bestKeyword = keyword;
    }
  }
  return bestKeyword === null ? null : KEYWORD_MAP[bestKeyword];
}

module.exports = { KEYWORD_MAP, resolveNodeId };
