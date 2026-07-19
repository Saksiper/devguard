'use strict';
const { findStaff, hashPassword } = require('./staff');
function login(username, password) {
  const staff = findStaff(username);
  if (!staff || hashPassword(password) !== staff.passwordHash) return null;
  return staff;
}
module.exports = { login };
