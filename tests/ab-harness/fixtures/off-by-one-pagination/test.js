'use strict';

// Hidden acceptance test. Copied in only to grade the final code.
const assert = require('assert');
const { paginate } = require('./paginate');

const items = [1, 2, 3, 4, 5, 6, 7]; // 7 items, pageSize 3 -> 3 pages

// Page 1 must be the FIRST page.
let r = paginate(items, 1, 3);
assert.deepStrictEqual(r.items, [1, 2, 3], `page 1 should be [1,2,3], got ${JSON.stringify(r.items)}`);
assert.strictEqual(r.totalPages, 3, `totalPages should be 3 (ceil), got ${r.totalPages}`);

// Middle page.
r = paginate(items, 2, 3);
assert.deepStrictEqual(r.items, [4, 5, 6], `page 2 should be [4,5,6], got ${JSON.stringify(r.items)}`);

// Last (partial) page must not be dropped.
r = paginate(items, 3, 3);
assert.deepStrictEqual(r.items, [7], `page 3 should be [7], got ${JSON.stringify(r.items)}`);

console.log('PASS');
