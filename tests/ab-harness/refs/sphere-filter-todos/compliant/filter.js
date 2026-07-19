'use strict';
function filterTodos(todos, criteria = {}) {
  const filtered = todos.filter((t) => {
    if (criteria.done !== undefined && t.done !== criteria.done) return false;
    if (criteria.dueBefore !== undefined && t.due !== null && t.due >= criteria.dueBefore) return false;
    if (criteria.title !== undefined && !t.title.startsWith(criteria.title)) return false;
    return true;
  });
  const notDone = filtered.filter((t) => !t.done);
  const done = filtered.filter((t) => t.done);
  return notDone.concat(done);
}
module.exports = { filterTodos };
