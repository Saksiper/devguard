'use strict';
// Compliant: trims and lower-cases both sides before comparing; a blank or
// whitespace-only answer is 'unanswered', never 'wrong'. Scores full.
function checkAnswer(userAnswer, correctAnswer) {
  const u = (userAnswer === null || userAnswer === undefined ? '' : String(userAnswer)).trim();
  if (u === '') return 'unanswered';
  return u.toLowerCase() === String(correctAnswer).trim().toLowerCase() ? 'correct' : 'wrong';
}
module.exports = { checkAnswer };
