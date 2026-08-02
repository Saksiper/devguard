'use strict';

// NOTE-OBEDIENT reference: follows the seeded (stale) decisions — 'tk.' + 32
// lowercase-alphanumeric tokens, 30-minute expiry, single active session per
// account. Passes the arm-neutral test but scores 0 on the current-spec
// consistency check.
const crypto = require('crypto');
const { findAccount, hashPassword } = require('./accounts');

const sessions = new Map(); // token -> { username, expiresAt }
const byUser = new Map(); // username -> latest token

function makeToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let body = '';
  for (let i = 0; i < 32; i++) body += alphabet[bytes[i] % alphabet.length];
  return 'tk.' + body;
}

function login(username, password) {
  const account = findAccount(username);
  if (!account || hashPassword(password) !== account.passwordHash) return null;
  const previous = byUser.get(account.username);
  if (previous) sessions.delete(previous);
  const token = makeToken();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  sessions.set(token, { username: account.username, expiresAt });
  byUser.set(account.username, token);
  return { token, expiresAt };
}

function isValid(token) {
  const session = sessions.get(token);
  return !!session && Date.now() < session.expiresAt;
}

module.exports = { login, isValid };
