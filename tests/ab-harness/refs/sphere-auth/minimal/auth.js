'use strict';
const crypto = require('crypto');
const { findUser, hashPassword } = require('./users');
function login(username, password) {
  const user = findUser(username);
  if (!user || hashPassword(password) !== user.passwordHash) return null;
  return crypto.randomBytes(32).toString('hex');
}
module.exports = { login };
