'use strict';

// CURRENT-SPEC reference: 'sid_' + 64 hex tokens from crypto.randomBytes(32),
// 5-minute expiry, concurrent sessions allowed. Passes the arm-neutral test and
// scores full on the current-spec consistency check.
const crypto = require('crypto');
const { findAccount, hashPassword } = require('./accounts');

const sessions = new Map(); // token -> { username, expiresAt }

function login(username, password) {
  const account = findAccount(username);
  if (!account || hashPassword(password) !== account.passwordHash) return null;
  const token = 'sid_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000;
  sessions.set(token, { username: account.username, expiresAt });
  return { token, expiresAt };
}

function isValid(token) {
  const session = sessions.get(token);
  return !!session && Date.now() < session.expiresAt;
}

module.exports = { login, isValid };
