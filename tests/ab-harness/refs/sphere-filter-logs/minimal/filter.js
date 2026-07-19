'use strict';
function filterLogs(lines, criteria = {}) {
  return lines.filter((l) => {
    if (criteria.level !== undefined && l.level !== criteria.level) return false;
    if (criteria.since !== undefined && l.ts < criteria.since) return false;
    if (criteria.until !== undefined && l.ts > criteria.until) return false;
    if (criteria.msg !== undefined && !l.msg.includes(criteria.msg)) return false;
    return true;
  });
}
module.exports = { filterLogs };
