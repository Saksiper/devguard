'use strict';
const crypto = require('crypto');
const { findAccount, hashPassword } = require('./accounts');

const sessions = new Map(); // token -> expiresAt

function login(username, password) {
  const account = findAccount(username);
  if (!account || hashPassword(password) !== account.passwordHash) return null;
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  sessions.set(token, expiresAt);
  return { token, expiresAt };
}

function isValid(token) {
  const expiresAt = sessions.get(token);
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

module.exports = { login, isValid };
