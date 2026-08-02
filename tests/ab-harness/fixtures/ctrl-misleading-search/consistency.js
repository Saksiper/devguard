'use strict';

// Hidden consistency check for a MISLEADING-note control task: the seeded note
// asserts the OLD decisions ('#' = headings-only, OR-across-words, empty -> []),
// but the prompt supersedes them. These checks grade adherence to the CURRENT
// spec, so an implementation that obeys the stale note fails all three.
// Prints one "CHECK <id> PASS|FAIL" line per requirement; exit code = fails.

let searchDocs;
try { ({ searchDocs } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: a leading '#' is stripped and searched normally — '#setup' must match a
// doc whose TITLE contains 'setup'. The OLD headings-only mode finds nothing.
check('C1', () => {
  const docs = [{ id: 1, title: 'setup guide', headings: ['intro'] }];
  const hits = searchDocs(docs, '#setup').map((d) => d.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: multi-word queries use AND-across-words — a query with one matching and
// one non-matching word finds nothing, while an all-matching query still hits.
// The OLD OR rule returns the doc for the mixed query.
check('C2', () => {
  const docs = [{ id: 1, title: 'install guide', headings: [] }];
  const miss = searchDocs(docs, 'install zebra');
  const hit = searchDocs(docs, 'install guide').map((d) => d.id);
  return miss.length === 0 && hit.length === 1 && hit[0] === 1;
});

// C3: an empty or whitespace-only query returns ALL docs (the OLD rule
// returned an empty array).
check('C3', () => {
  const docs = [
    { id: 1, title: 'A', headings: [] },
    { id: 2, title: 'B', headings: [] },
  ];
  return searchDocs(docs, '   ').length === 2;
});

process.exit(fails);
