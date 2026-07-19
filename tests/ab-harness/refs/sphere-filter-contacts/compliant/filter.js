'use strict';
function filterContacts(contacts, criteria = {}) {
  if (Object.keys(criteria).length === 0) return [];
  const matches = contacts.filter((c) => {
    if (criteria.name !== undefined && !c.name.includes(criteria.name)) return false;
    if (criteria.domain !== undefined) {
      const wantDomain = criteria.domain.startsWith('@') ? criteria.domain.slice(1) : criteria.domain;
      if (c.email.split('@')[1] !== wantDomain) return false;
    }
    return true;
  });
  return [...matches.filter((c) => c.favorite), ...matches.filter((c) => !c.favorite)];
}
module.exports = { filterContacts };
