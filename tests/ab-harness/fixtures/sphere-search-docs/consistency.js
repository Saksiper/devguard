'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let searchDocs;
try { ({ searchDocs } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: a query starting with '#' searches headings ONLY, not the title. Doc 2's
// title contains 'setup' but has no 'setup' heading, so it must not match.
check('C1', () => {
  const docs = [
    { id: 1, title: 'random doc', headings: ['setup', 'usage'] },
    { id: 2, title: 'setup guide', headings: ['intro', 'notes'] },
  ];
  const hits = searchDocs(docs, '#setup').map((d) => d.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: a plain query with multiple words uses OR-across-words semantics — a doc
// matches if ANY word in the query matches (in the title or a heading), not only
// when EVERY word matches. Doc 1 matches via the word 'authentication' alone; the
// second word 'zzz' matches nothing anywhere, so an AND-across-words (or whole-
// phrase) implementation would wrongly exclude it.
check('C2', () => {
  const docs = [
    { id: 1, title: 'API overview', headings: ['authentication flow', 'rate limiting'] },
    { id: 2, title: 'reference', headings: ['defaults'] },
  ];
  const hits = searchDocs(docs, 'authentication zzz').map((d) => d.id);
  return hits.length === 1 && hits[0] === 1;
});

// C3: an empty or whitespace-only query returns [] — not every doc. A naive
// substring check ('x'.includes('')) treats an empty query as matching everything.
check('C3', () => {
  const docs = [
    { id: 1, title: 'a', headings: ['x'] },
    { id: 2, title: 'b', headings: ['y'] },
  ];
  return searchDocs(docs, '   ').length === 0 && searchDocs(docs, '').length === 0;
});

process.exit(fails);
