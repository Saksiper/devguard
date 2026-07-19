'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let searchEmails;
try { ({ searchEmails } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: a 'from:' token restricts results to senders whose from-address contains
// that value; remaining words match the subject. A plain literal-substring
// search treats 'from:carol budget' as one string and matches nothing.
check('C1', () => {
  const emails = [
    { id: 1, subject: 'budget notes', from: 'carol@example.com', body: '', ts: 1 },
    { id: 2, subject: 'budget notes', from: 'dave@example.com', body: '', ts: 2 },
  ];
  const hits = searchEmails(emails, 'from:carol budget').map((e) => e.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: results come back sorted newest-first by ts. Input is deliberately out
// of ts order — an implementation that keeps insertion order fails.
check('C2', () => {
  const emails = [
    { id: 1, subject: 'weekly update', from: 'a@x.com', body: '', ts: 100 },
    { id: 2, subject: 'weekly update', from: 'b@x.com', body: '', ts: 300 },
    { id: 3, subject: 'weekly update', from: 'c@x.com', body: '', ts: 200 },
  ];
  return searchEmails(emails, 'weekly').map((e) => e.id).join(',') === '2,3,1';
});

// C3: a double-quoted query is an exact, case-sensitive substring match on
// the subject. A plain includes(query) with quotes left in place matches
// nothing (subjects hold no literal quote characters).
check('C3', () => {
  const emails = [
    { id: 1, subject: 'Budget Report Final', from: 'a@x.com', body: '', ts: 1 },
    { id: 2, subject: 'budget report final draft', from: 'b@x.com', body: '', ts: 2 },
  ];
  const hits = searchEmails(emails, '"Budget Report Final"').map((e) => e.id);
  return hits.length === 1 && hits[0] === 1;
});

process.exit(fails);
