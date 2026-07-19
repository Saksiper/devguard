'use strict';
const { findMember } = require('./members');

const codes = new Map(); // email -> latest code

function requestCode(email) {
  const member = findMember(email);
  if (!member) return null;
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  codes.set(email, code); // replaces (regenerates) any previous code
  return { email, code };
}

function verifyCode(email, code) {
  return codes.get(email) === code;
}

module.exports = { requestCode, verifyCode };
