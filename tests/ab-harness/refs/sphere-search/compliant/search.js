'use strict';
function searchNotes(notes, query) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    const title = n.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}
module.exports = { searchNotes };
