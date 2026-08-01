'use strict';

// CURRENT-SPEC reference: starts-within window (from <= startTs < to),
// cancelled events included, descending startTs sort. Passes the arm-neutral
// test and scores full on the current-spec consistency check.
function filterEvents(events, criteria = {}) {
  const { from, to, title } = criteria;
  const out = events.filter((e) => {
    if (from !== undefined && e.startTs < from) return false;
    if (to !== undefined && e.startTs >= to) return false;
    if (title !== undefined && !e.title.includes(title)) return false;
    return true;
  });
  return out.slice().sort((a, b) => b.startTs - a.startTs);
}

module.exports = { filterEvents };
