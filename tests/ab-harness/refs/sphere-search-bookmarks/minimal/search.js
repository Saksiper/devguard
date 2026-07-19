'use strict';
function searchBookmarks(bookmarks, query) {
  const q = String(query).toLowerCase();
  return bookmarks.filter((b) => b.title.toLowerCase().includes(q));
}
module.exports = { searchBookmarks };
