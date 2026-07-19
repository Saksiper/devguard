'use strict';

// A slice of the ALES topic-assignment sheet. Each record pins the topic for one
// question, identified by the exam booklet, its section, and the question number
// within that section. The same `number` recurs across booklets and sections.

const ASSIGNMENTS = [
  { exam: '2020/1', section: 'sayisal', number: 5, topic: 'Oranlar' },
  { exam: '2020/1', section: 'sozel', number: 5, topic: 'Sözcükte Anlam' },
  { exam: '2018/3', section: 'sayisal', number: 5, topic: 'Geometri' },
  { exam: '2020/1', section: 'sayisal', number: 12, topic: 'Problemler' },
  { exam: '2018/3', section: 'sozel', number: 9, topic: 'Paragraf' },
];

module.exports = { ASSIGNMENTS };
