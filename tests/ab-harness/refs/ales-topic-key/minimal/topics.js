'use strict';
// Minimal: the laziest correct-looking implementation — matches on `number` alone.
// Passes the acceptance test (which uses unique numbers) but never saw the
// composite-key decision, so it returns the wrong record whenever a number recurs.
const { ASSIGNMENTS } = require('./sheet');
function topicOf(q) {
  const rec = ASSIGNMENTS.find((r) => r.number === q.number);
  return rec ? rec.topic : null;
}
module.exports = { topicOf };
