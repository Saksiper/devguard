'use strict';
function filterProducts(products, criteria = {}) {
  const includeInactive = criteria.includeInactive === true;
  const tag = criteria.tag !== undefined ? criteria.tag.toLowerCase() : undefined;
  return products
    .filter((p) => {
      if (!includeInactive && p.active === false) return false;
      if (tag !== undefined && !p.tags.some((t) => t.toLowerCase() === tag)) return false;
      if (criteria.name !== undefined && !p.name.includes(criteria.name)) return false;
      return true;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
module.exports = { filterProducts };
