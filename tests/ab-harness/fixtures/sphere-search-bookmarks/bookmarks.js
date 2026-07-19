'use strict';

// Tiny in-memory bookmarks store. Bookmarks: { id, title, url, tags }.
// tags is an array of strings.

let nextId = 1;

function createStore() {
  return { bookmarks: [] };
}

function addBookmark(store, title, url, tags = []) {
  const bookmark = { id: nextId++, title, url, tags };
  store.bookmarks.push(bookmark);
  return bookmark;
}

function listBookmarks(store) {
  return store.bookmarks;
}

module.exports = { createStore, addBookmark, listBookmarks };
