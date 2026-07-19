'use strict';
// Minimal: the obvious score — count of correct answers. Passes the no-wrong
// acceptance test, but never saw the negative-marking decision, so it scores 0.
function scoreExam(answers, key) {
  let correct = 0;
  for (let i = 0; i < key.length; i++) {
    if (answers[i] === key[i]) correct++;
  }
  return correct;
}
module.exports = { scoreExam };
