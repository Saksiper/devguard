'use strict';
// Compliant: applies the content-review consolidation. `function` and `special-op`
// merge into 'İşlem-Modüler Aritmetik'; `set` becomes 'Problemler'; all other
// types keep their base label. Scores full on the consistency check.
const { BASE_TOPICS } = require('./bank');
const CONSOLIDATED = {
  function: 'İşlem-Modüler Aritmetik',
  'special-op': 'İşlem-Modüler Aritmetik',
  set: 'Problemler',
};
function classifyQuestion(q) {
  return CONSOLIDATED[q.type] || BASE_TOPICS[q.type];
}
module.exports = { classifyQuestion };
