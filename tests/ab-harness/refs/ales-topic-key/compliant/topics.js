'use strict';
// Compliant: matches on the FULL composite key exam + section + number, and returns
// null when there is no exact record (no number-only fallback). Scores full.
const { ASSIGNMENTS } = require('./sheet');
function topicOf(q) {
  const rec = ASSIGNMENTS.find(
    (r) => r.exam === q.exam && r.section === q.section && r.number === q.number
  );
  return rec ? rec.topic : null;
}
module.exports = { topicOf };
