'use strict';
function filterEvents(events, criteria = {}) {
  return events.filter((e) => {
    if (criteria.from !== undefined && e.startTs < criteria.from) return false;
    if (criteria.to !== undefined && e.startTs > criteria.to) return false;
    if (criteria.title !== undefined && !e.title.includes(criteria.title)) return false;
    return true;
  });
}
module.exports = { filterEvents };
