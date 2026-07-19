'use strict';
const { findMember } = require('./members');

const CODE_TTL_MS = 10 * 60 * 1000;
const current = new Map(); // email -> latest { email, code, validUntilTs }

function generateCode() {
  return 'MB-' + String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

function requestCode(email) {
  const member = findMember(email);
  if (!member) return null;
  const existing = current.get(email);
  if (existing && existing.validUntilTs > Date.now()) {
    return existing; // still valid — resending returns the same code, not a new one
  }
  const record = { email, code: generateCode(), validUntilTs: Date.now() + CODE_TTL_MS };
  current.set(email, record);
  return record;
}

function verifyCode(email, code) {
  const record = current.get(email);
  return !!record && record.code === code;
}

module.exports = { requestCode, verifyCode };
