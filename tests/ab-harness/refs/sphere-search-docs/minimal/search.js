'use strict';
function searchDocs(docs, query) {
  return docs.filter((d) => d.title.includes(query));
}
module.exports = { searchDocs };
