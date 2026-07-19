'use strict';
function filterEntries(entries, criteria = {}) {
  return entries.filter((e) => {
    if (criteria.status !== undefined && e.status !== criteria.status) return false;
    if (criteria.from !== undefined && e.ts < criteria.from) return false;
    if (criteria.to !== undefined && e.ts > criteria.to) return false;
    if (criteria.title !== undefined && !e.title.includes(criteria.title)) return false;
    return true;
  });
}
module.exports = { filterEntries };
