'use strict';
const crypto = require('crypto');
const { findAccount, hashPassword } = require('./accounts');

const sessions = new Map(); // token -> { username, expiresAt }
const activeTokenByUser = new Map(); // username -> token

function makeToken() {
  return 'tk.' + crypto.randomBytes(16).toString('hex');
}

function login(username, password) {
  const account = findAccount(username);
  if (!account || hashPassword(password) !== account.passwordHash) return null;
  const prevToken = activeTokenByUser.get(account.username);
  if (prevToken) sessions.delete(prevToken);
  const token = makeToken();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  sessions.set(token, { username: account.username, expiresAt });
  activeTokenByUser.set(account.username, token);
  return { token, expiresAt };
}

function isValid(token) {
  const session = sessions.get(token);
  return !!session && session.expiresAt > Date.now();
}

module.exports = { login, isValid };
