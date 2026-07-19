'use strict';
function searchEmails(emails, query) {
  if (typeof query !== 'string') return [];

  // C3: a fully double-quoted query is an exact, case-sensitive substring
  // match on the subject.
  const quoted = query.match(/^"(.*)"$/);
  if (quoted) {
    const exact = quoted[1];
    return emails
      .filter((e) => e.subject.includes(exact))
      .sort((a, b) => b.ts - a.ts);
  }

  // C1: split into an optional 'from:' token plus subject words.
  let fromToken = null;
  const subjectWords = [];
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const m = word.match(/^from:(.+)$/i);
    if (m) fromToken = m[1].toLowerCase();
    else subjectWords.push(word.toLowerCase());
  }

  return emails
    .filter((e) => {
      if (fromToken && !e.from.toLowerCase().includes(fromToken)) return false;
      const subject = e.subject.toLowerCase();
      return subjectWords.every((w) => subject.includes(w));
    })
    .sort((a, b) => b.ts - a.ts); // C2: newest-first (inbox order)
}
module.exports = { searchEmails };
