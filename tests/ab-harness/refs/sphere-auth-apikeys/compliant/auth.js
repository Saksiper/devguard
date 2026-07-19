'use strict';

const { getKeys, hashKey } = require('./keys');

function authenticate(apiKey) {
  try {
    let clean = String(apiKey).trim();
    if (clean.startsWith('key-')) clean = clean.slice(4);
    const hash = hashKey(clean);
    const match = getKeys().find((k) => k.keyHash === hash);
    if (!match) return false;
    return { name: match.name, scopes: ['read'] };
  } catch {
    return false;
  }
}

module.exports = { authenticate };
