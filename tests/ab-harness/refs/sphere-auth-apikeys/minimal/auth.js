'use strict';

const { getKeys, hashKey } = require('./keys');

function authenticate(apiKey) {
  const hash = hashKey(apiKey);
  const match = getKeys().find((k) => k.keyHash === hash);
  return match ? { name: match.name } : null;
}

module.exports = { authenticate };
