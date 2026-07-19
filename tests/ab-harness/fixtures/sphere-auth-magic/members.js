'use strict';

// Membership list backed by members.json. This is the existing feature the
// login task extends.

const fs = require('fs');
const path = require('path');

const MEMBERS_FILE = path.join(__dirname, 'members.json');

const members = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));

function getMembers() {
  return members;
}

function findMember(email) {
  return members.find((m) => m.email === email) || null;
}

module.exports = { getMembers, findMember, MEMBERS_FILE };
