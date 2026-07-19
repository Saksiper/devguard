'use strict';
function filterEntries(entries, criteria = {}) {
  const t = criteria.title !== undefined ? criteria.title.toLowerCase() : undefined;
  return entries
    .filter((e) => {
      if (criteria.status !== undefined && e.status !== criteria.status) return false;
      if (criteria.from !== undefined && e.ts < criteria.from) return false;
      if (criteria.to !== undefined && e.ts >= criteria.to) return false;
      if (t !== undefined && !e.title.toLowerCase().includes(t)) return false;
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}
module.exports = { filterEntries };
