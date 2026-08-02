'use strict';

// Tiny in-memory markdown docs module. Docs: { id, title, headings } where
// headings is an array of heading-text strings.

let nextId = 1;

function createStore() {
  return { docs: [] };
}

function addDoc(store, title, headings) {
  const doc = { id: nextId++, title, headings };
  store.docs.push(doc);
  return doc;
}

function listDocs(store) {
  return store.docs;
}

module.exports = { createStore, addDoc, listDocs };
