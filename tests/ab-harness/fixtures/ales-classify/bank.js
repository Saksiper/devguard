'use strict';

// A slice of the ALES exam question bank. Each question has a `type`; the app
// renders questions grouped by TOPIC. BASE_TOPICS is the obvious per-type label
// map — the starting point before the content review consolidated some buckets.

const BASE_TOPICS = {
  ratio: 'Oranlar',
  probability: 'Olasılık',
  geometry: 'Geometri',
  function: 'Fonksiyonlar',
  'special-op': 'Özel İşlem',
  set: 'Kümeler',
};

function questions() {
  return [
    { id: 1, type: 'ratio', stem: 'a/b oranı...' },
    { id: 2, type: 'function', stem: 'f(x) = ...' },
    { id: 3, type: 'set', stem: 'A ∪ B kümesi...' },
    { id: 4, type: 'special-op', stem: 'a ⊕ b = ...' },
    { id: 5, type: 'geometry', stem: 'üçgenin alanı...' },
  ];
}

module.exports = { BASE_TOPICS, questions };
