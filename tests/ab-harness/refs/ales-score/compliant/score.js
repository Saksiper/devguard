'use strict';
// Compliant: net score with negative marking — correct − wrong/4, blanks exempt,
// floored at 0. Scores full.
function scoreExam(answers, key) {
  let correct = 0;
  let wrong = 0;
  for (let i = 0; i < key.length; i++) {
    const a = answers[i];
    if (a === '' || a === null || a === undefined) continue; // blank: exempt
    if (a === key[i]) correct++;
    else wrong++;
  }
  return Math.max(0, correct - wrong / 4);
}
module.exports = { scoreExam };
