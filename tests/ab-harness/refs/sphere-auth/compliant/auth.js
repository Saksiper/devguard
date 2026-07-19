'use strict';
const crypto = require('crypto');
const { getUsers, hashPassword } = require('./users');
function login(username, password) {
  const uname = String(username).toLowerCase();
  const user = getUsers().find((u) => u.username.toLowerCase() === uname);
  if (!user || hashPassword(password) !== user.passwordHash) return null;
  user.lastLoginTs = Date.now();
  return 'sess_' + crypto.randomBytes(24).toString('hex');
}
module.exports = { login };
