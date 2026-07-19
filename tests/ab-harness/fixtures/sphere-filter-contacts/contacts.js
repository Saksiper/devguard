'use strict';

// Tiny in-memory contact book. Contacts: { id, name, email, favorite }.
// favorite is a boolean flag marking important contacts.

let nextId = 1;

function createBook() {
  return { contacts: [] };
}

function addContact(book, name, email, favorite = false) {
  const contact = { id: nextId++, name, email, favorite };
  book.contacts.push(contact);
  return contact;
}

function listContacts(book) {
  return book.contacts;
}

module.exports = { createBook, addContact, listContacts };
