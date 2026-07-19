'use strict';

// API key store backed by keys.json. Keys are stored as sha256 hex digests
// of the plaintext key (see hashKey). This is the existing feature the
// authenticate task extends.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_FILE = path.join(__dirname, 'keys.json');

const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function getKeys() {
  return keys;
}

module.exports = { getKeys, hashKey, KEYS_FILE };
