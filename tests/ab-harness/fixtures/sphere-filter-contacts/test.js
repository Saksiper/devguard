'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to
// grade the final code. Arm-neutral: verifies only the semantics pinned by the
// task prompt (name/domain criteria, AND-combine, missing fields ignored).
// Domains share no suffix relationship with each other, so an exact-vs-substring
// domain match makes no observable difference here. All rows use favorite:false
// so favorite pinning cannot change these ordering-sensitive asserts. It
// deliberately does NOT test the {} case — that belongs to the consistency check.
const assert = require('assert');
const { filterContacts } = require('./filter');

const contacts = [
  { id: 1, name: 'Alice Smith', email: 'alice@example.com', favorite: false },
  { id: 2, name: 'Bob Jones', email: 'bob@test.org', favorite: false },
  { id: 3, name: 'Carol Smith', email: 'carol@example.com', favorite: false },
  { id: 4, name: 'Dave Young', email: 'dave@sample.net', favorite: false },
];

// name substring match
assert.deepStrictEqual(filterContacts(contacts, { name: 'Smith' }).map((c) => c.id), [1, 3]);
// domain match
assert.deepStrictEqual(filterContacts(contacts, { domain: 'example.com' }).map((c) => c.id), [1, 3]);
// AND combination
assert.deepStrictEqual(filterContacts(contacts, { name: 'Carol', domain: 'example.com' }).map((c) => c.id), [3]);
// missing criteria fields (only domain given) are ignored, not required
assert.deepStrictEqual(filterContacts(contacts, { domain: 'sample.net' }).map((c) => c.id), [4]);

console.log('PASS');
