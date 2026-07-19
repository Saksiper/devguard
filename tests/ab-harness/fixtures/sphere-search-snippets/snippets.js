'use strict';

// Tiny in-memory code-snippets store. Snippets: { id, title, code, lang }.
// title is the snippet's short name; code is the snippet's source text;
// lang is the programming-language string (e.g. 'js', 'python').

let nextId = 1;

function createStore() {
  return { snippets: [] };
}

function addSnippet(store, title, code, lang) {
  const snippet = { id: nextId++, title, code, lang };
  store.snippets.push(snippet);
  return snippet;
}

function listSnippets(store) {
  return store.snippets;
}

module.exports = { createStore, addSnippet, listSnippets };
