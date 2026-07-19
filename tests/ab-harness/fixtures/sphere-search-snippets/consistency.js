'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let searchSnippets;
try { ({ searchSnippets } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: a 'lang:x' token filters by exact language; remaining words match
// normally. Two snippets share a title word but differ in lang — only the
// one matching both the lang: token and the remaining word should hit.
check('C1', () => {
  const snippets = [
    { id: 1, title: 'Sort Util', code: 'function s(a){return a;}', lang: 'js' },
    { id: 2, title: 'Sort Util', code: 'def s(a): return a', lang: 'python' },
  ];
  const hits = searchSnippets(snippets, 'lang:js Sort').map((s) => s.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: matching inside code is case-sensitive (a differently-cased identifier
// must not match, but the correctly-cased identifier must) while title
// matching is case-insensitive. The two halves use disjoint data so neither
// half leaks into the other's result.
check('C2', () => {
  const titleSet = [
    { id: 1, title: 'FIZZBUZZ helper', code: 'return n % 3;', lang: 'js' },
    { id: 2, title: 'random util', code: 'return 0;', lang: 'js' },
  ];
  const codeSet = [
    { id: 3, title: 'placeholder one', code: 'let myVar = 1;', lang: 'js' },
    { id: 4, title: 'placeholder two', code: 'return 2;', lang: 'js' },
  ];
  const titleHit = searchSnippets(titleSet, 'fizzbuzz').map((s) => s.id);
  const codeHit = searchSnippets(codeSet, 'myvar').map((s) => s.id);
  const codePos = searchSnippets(codeSet, 'myVar').map((s) => s.id);
  return titleHit.length === 1 && titleHit[0] === 1 && codeHit.length === 0 &&
    codePos.length === 1 && codePos[0] === 3;
});

// C3: results come back sorted by title ascending. Input is deliberately out
// of alphabetical order — an implementation that keeps insertion order fails.
check('C3', () => {
  const snippets = [
    { id: 1, title: 'Zebra Print', code: 'return 1;', lang: 'js' },
    { id: 2, title: 'Alpha Print', code: 'return 2;', lang: 'js' },
    { id: 3, title: 'Mango Print', code: 'return 3;', lang: 'js' },
  ];
  const titles = searchSnippets(snippets, 'Print').map((s) => s.title);
  return titles.join(',') === 'Alpha Print,Mango Print,Zebra Print';
});

process.exit(fails);
