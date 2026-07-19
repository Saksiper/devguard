'use strict';

// Return the slice of `items` on the given 1-indexed `page`, `pageSize` per page,
// plus pagination metadata. Page 1 is the first page.
function paginate(items, page, pageSize) {
  const offset = page * pageSize;
  const pageItems = items.slice(offset, offset + pageSize);
  const totalPages = Math.floor(items.length / pageSize);
  return { page, pageSize, totalPages, items: pageItems };
}

module.exports = { paginate };
