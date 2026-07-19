'use strict';

const CONTINENTS = Object.freeze([
  'ui_ux', 'security', 'data', 'logic', 'infra', 'math', 'test', 'docs',
]);

function normalizeCountry(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isValidNodeId(s) {
  if (typeof s !== 'string') return false;
  const slash = s.indexOf('/');
  if (slash === -1 || s.indexOf('/', slash + 1) !== -1) return false;
  const continent = s.slice(0, slash);
  const country = s.slice(slash + 1);
  if (!CONTINENTS.includes(continent)) return false;
  return country.length > 0 && country === normalizeCountry(country);
}

module.exports = { CONTINENTS, normalizeCountry, isValidNodeId };
