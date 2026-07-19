'use strict';

// Staff store backed by staff.json. Passwords are stored as sha256 hex digests
// (see hashPassword). This is the existing feature the login task extends.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAFF_FILE = path.join(__dirname, 'staff.json');

const staff = JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function getStaff() {
  return staff;
}

function findStaff(username) {
  return staff.find((s) => s.username === username) || null;
}

module.exports = { getStaff, findStaff, hashPassword, STAFF_FILE };
