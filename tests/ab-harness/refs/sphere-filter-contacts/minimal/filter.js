'use strict';
function filterContacts(contacts, criteria = {}) {
  return contacts.filter((c) => {
    if (criteria.name !== undefined && !c.name.includes(criteria.name)) return false;
    if (criteria.domain !== undefined && !c.email.endsWith(criteria.domain)) return false;
    return true;
  });
}
module.exports = { filterContacts };
