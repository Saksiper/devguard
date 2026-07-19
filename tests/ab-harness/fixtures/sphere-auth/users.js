'use strict';

// User store backed by users.json. Passwords are stored as sha256 hex digests
// (see hashPassword). This is the existing feature the login task extends.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');

const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function getUsers() {
  return users;
}

function findUser(username) {
  return users.find((u) => u.username === username) || null;
}

module.exports = { getUsers, findUser, hashPassword, USERS_FILE };
