'use strict';

// Tiny in-memory email inbox. Emails: { id, subject, from, body, ts } (ts = epoch ms).

let nextId = 1;

function createInbox() {
  return { emails: [] };
}

function addEmail(inbox, subject, from, body, ts) {
  const email = { id: nextId++, subject, from, body, ts };
  inbox.emails.push(email);
  return email;
}

function listEmails(inbox) {
  return inbox.emails;
}

module.exports = { createInbox, addEmail, listEmails };
