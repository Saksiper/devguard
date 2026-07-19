'use strict';
const { findStaff, hashPassword } = require('./staff');
function login(username, password) {
  const uname = String(username).trim();
  const staff = findStaff(uname);
  if (!staff || hashPassword(password) !== staff.passwordHash) return null;
  const rest = { ...staff, role: staff.role || 'viewer' };
  delete rest.passwordHash;
  return Object.freeze(rest);
}
module.exports = { login };
