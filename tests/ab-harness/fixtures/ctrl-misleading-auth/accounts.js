'use strict';

// Account store backed by accounts.json. Passwords are stored as sha256 hex
// digests (see hashPassword). This is the existing feature the login task
// extends with session support in a new auth.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function getAccounts() {
  return accounts;
}

function findAccount(username) {
  return accounts.find((a) => a.username === username) || null;
}

module.exports = { getAccounts, findAccount, hashPassword, ACCOUNTS_FILE };
