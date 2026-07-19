'use strict';
function filterEvents(events, criteria = {}) {
  const includeCancelled = criteria.includeCancelled === true;
  return events
    .filter((e) => {
      if (!includeCancelled && e.cancelled) return false;
      if (criteria.from !== undefined && e.endTs <= criteria.from) return false;
      if (criteria.to !== undefined && e.startTs >= criteria.to) return false;
      if (criteria.title !== undefined && !e.title.includes(criteria.title)) return false;
      return true;
    })
    .sort((a, b) => a.startTs - b.startTs);
}
module.exports = { filterEvents };
