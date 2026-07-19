'use strict';
function searchEmails(emails, query) {
  return emails.filter((e) => e.subject.includes(query));
}
module.exports = { searchEmails };
