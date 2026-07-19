'use strict';

// Tiny in-memory notes module. Notes: { id, title, body, ts } (ts = epoch ms).

let nextId = 1;

function createStore() {
  return { notes: [] };
}

function addNote(store, title, body, ts) {
  const note = { id: nextId++, title, body, ts };
  store.notes.push(note);
  return note;
}

function listNotes(store) {
  return store.notes;
}

module.exports = { createStore, addNote, listNotes };
