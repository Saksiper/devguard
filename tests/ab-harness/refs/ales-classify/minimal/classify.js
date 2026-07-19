'use strict';
// Minimal: the laziest correct implementation — returns the obvious base label
// for each type. Never saw the taxonomy-consolidation decisions, so it scores 0.
const { BASE_TOPICS } = require('./bank');
function classifyQuestion(q) {
  return BASE_TOPICS[q.type];
}
module.exports = { classifyQuestion };
