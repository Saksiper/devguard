'use strict';
function filterProducts(products, criteria = {}) {
  return products.filter((p) => {
    if (criteria.tag !== undefined && !p.tags.includes(criteria.tag)) return false;
    if (criteria.name !== undefined && !p.name.includes(criteria.name)) return false;
    return true;
  });
}
module.exports = { filterProducts };
