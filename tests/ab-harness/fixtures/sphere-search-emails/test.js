'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a plain
// subject-word query returns the matching emails). It deliberately uses no
// 'from:' tokens and no quoted queries, and compares ids sorted so it is
// neutral on the inbox sort-order decision — those and the from:/quote
// semantics belong to the consistency check. Body text below never repeats a
// functional query word, only the subject does.
const assert = require('assert');
const { searchEmails } = require('./search');

const emails = [
  { id: 1, subject: 'quarterly budget review', from: 'carol@example.com', body: 'numbers attached', ts: 1000 },
  { id: 2, subject: 'team lunch plans', from: 'dave@example.com', body: 'pick a place', ts: 2000 },
  { id: 3, subject: 'budget approval needed', from: 'erin@example.com', body: 'please sign off', ts: 3000 },
];

const ids = (result) => result.map((e) => e.id).sort((a, b) => a - b);

// plain subject-word query (same case as the data, so any case rule passes)
assert.deepStrictEqual(ids(searchEmails(emails, 'budget')), [1, 3]);
assert.deepStrictEqual(ids(searchEmails(emails, 'lunch')), [2]);
// no match anywhere -> empty
assert.deepStrictEqual(searchEmails(emails, 'zzz-no-such-token'), []);

console.log('PASS');
