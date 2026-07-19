'use strict';
function searchNotes(notes, query) {
  return notes.filter((n) => n.title.includes(query));
}
module.exports = { searchNotes };
