'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let filterProducts;
try { ({ filterProducts } = require('./filter')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: inactive products are excluded by default. A minimal implementation
// that never checks `active` at all returns both products.
check('C1', () => {
  const products = [
    { id: 1, name: 'A', priceCents: 100, tags: [], active: true },
    { id: 2, name: 'B', priceCents: 200, tags: [], active: false },
  ];
  const hits = filterProducts(products, {}).map((p) => p.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: tag matching lowercases both sides (case-insensitive) AND requires
// exact tag equality, not a substring. A case-sensitive exact-match
// implementation fails the first assertion; a substring implementation would
// fail the second.
check('C2', () => {
  const products = [
    { id: 1, name: 'A', priceCents: 100, tags: ['Sale'], active: true },
    { id: 2, name: 'B', priceCents: 200, tags: ['New'], active: true },
  ];
  const hitsCi = filterProducts(products, { tag: 'sale' }).map((p) => p.id);
  if (!(hitsCi.length === 1 && hitsCi[0] === 1)) return false;
  const hitsPartial = filterProducts(products, { tag: 'sal' }).map((p) => p.id);
  return hitsPartial.length === 0;
});

// C3: results come back sorted ascending by name. Input is deliberately out
// of alphabetical order — an implementation that keeps insertion order fails.
check('C3', () => {
  const products = [
    { id: 1, name: 'Zebra', priceCents: 100, tags: [], active: true },
    { id: 2, name: 'Apple', priceCents: 100, tags: [], active: true },
    { id: 3, name: 'Mango', priceCents: 100, tags: [], active: true },
  ];
  return filterProducts(products, {}).map((p) => p.id).join(',') === '2,3,1';
});

process.exit(fails);
