'use strict';
function filterTodos(todos, criteria = {}) {
  return todos.filter((t) => {
    if (criteria.done !== undefined && t.done !== criteria.done) return false;
    if (criteria.dueBefore !== undefined && (!t.due || t.due >= criteria.dueBefore)) return false;
    if (criteria.title !== undefined && !t.title.includes(criteria.title)) return false;
    return true;
  });
}
module.exports = { filterTodos };
