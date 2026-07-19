'use strict';

const SEVERITY = { debug: 0, info: 1, warn: 2, error: 3 };

function filterLogs(lines, criteria = {}) {
  const minLevel = criteria.level !== undefined ? SEVERITY[criteria.level.toLowerCase()] : undefined;
  const matches = lines.filter((l) => {
    if (minLevel !== undefined && SEVERITY[l.level.toLowerCase()] < minLevel) return false;
    if (criteria.since !== undefined && l.ts < criteria.since) return false;
    if (criteria.until !== undefined && l.ts > criteria.until) return false;
    if (criteria.msg !== undefined && !l.msg.includes(criteria.msg)) return false;
    return true;
  });
  matches.sort((a, b) => a.ts - b.ts);
  return matches.length > 100 ? matches.slice(-100) : matches;
}

module.exports = { filterLogs };
