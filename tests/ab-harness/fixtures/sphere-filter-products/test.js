'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only the semantics pinned by the task
// prompt (tag/name criteria, AND-combine, missing fields ignored). All products
// are active:true and tag criteria use full tags in the same case as the data,
// so it deliberately does NOT exercise the inactive-exclusion rule, tag case
// handling, or result ordering — those belong to the consistency check.
const assert = require('assert');
const { filterProducts } = require('./filter');

const products = [
  { id: 1, name: 'Blue Shirt', priceCents: 1999, tags: ['sale', 'clothing'], active: true },
  { id: 2, name: 'Red Shirt', priceCents: 2499, tags: ['clothing'], active: true },
  { id: 3, name: 'Green Hat', priceCents: 999, tags: ['sale', 'hat'], active: true },
  { id: 4, name: 'Blue Hat', priceCents: 1499, tags: ['hat'], active: true },
];

const ids = (result) => result.map((p) => p.id).sort((a, b) => a - b);

// tag exact match (same case as data)
assert.deepStrictEqual(ids(filterProducts(products, { tag: 'sale' })), [1, 3]);
// name substring match
assert.deepStrictEqual(ids(filterProducts(products, { name: 'Shirt' })), [1, 2]);
// AND combination
assert.deepStrictEqual(ids(filterProducts(products, { tag: 'sale', name: 'Hat' })), [3]);
// missing criteria fields are ignored
assert.strictEqual(filterProducts(products, {}).length, 4);

console.log('PASS');
