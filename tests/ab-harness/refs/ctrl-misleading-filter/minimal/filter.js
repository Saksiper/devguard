'use strict';

// NOTE-OBEDIENT reference: follows the seeded (stale) decisions — overlap
// window, cancelled excluded by default, ascending startTs sort. Passes the
// arm-neutral test but scores 0 on the current-spec consistency check.
function filterEvents(events, criteria = {}) {
  const { from, to, title, includeCancelled } = criteria;
  const out = events.filter((e) => {
    if (!includeCancelled && e.cancelled) return false;
    if (from !== undefined && e.endTs <= from) return false;
    if (to !== undefined && e.startTs >= to) return false;
    if (title !== undefined && !e.title.includes(title)) return false;
    return true;
  });
  return out.slice().sort((a, b) => a.startTs - b.startTs);
}

module.exports = { filterEvents };
