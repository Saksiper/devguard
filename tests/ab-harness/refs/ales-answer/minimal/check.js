'use strict';
// Minimal: a strict comparison — falsy answer is unanswered, else exact === decides
// correct/wrong. Passes the exact-match acceptance test, but never saw the
// normalization decisions, so it scores 0.
function checkAnswer(userAnswer, correctAnswer) {
  if (!userAnswer) return 'unanswered';
  return userAnswer === correctAnswer ? 'correct' : 'wrong';
}
module.exports = { checkAnswer };
