'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeTracks, compact, toText, formatTime, similarity } = require('../src/transcript');

test('formatTime', () => {
  assert.equal(formatTime(5), '00:05');
  assert.equal(formatTime(75.9), '01:15');
  assert.equal(formatTime(3725), '1:02:05');
});

test('mergeTracks etiketler ve sıralar', () => {
  const out = mergeTracks({
    mine: [{ start: 0, end: 3, text: 'merhaba ben başlatıyorum' }],
    others: [{ start: 4, end: 6, text: 'evet hazırız' }],
  });
  assert.deepEqual(out.map(s => s.speaker), ['Ben', 'Katılımcılar']);
});

test('hoparlörden mikrofona sızan yankı atılır', () => {
  const others = [{ start: 10, end: 14, text: 'rapor ekranı bitti test ortamına aldık' }];
  const mine = [
    { start: 10.2, end: 14.1, text: 'rapor ekranı bitti test ortamına' },   // yankı
    { start: 15, end: 17, text: 'harika teşekkürler' },                     // gerçek
  ];
  const out = mergeTracks({ mine, others });
  assert.equal(out.length, 2);
  assert.equal(out[0].speaker, 'Katılımcılar');
  assert.equal(out[1].text, 'harika teşekkürler');
  assert.ok(similarity('Rapor ekranı bitti', 'rapor ekranı bitti mi') > 0.9);
});

test('compact aynı konuşmacının ardışık parçalarını birleştirir', () => {
  const out = compact([
    { start: 0, end: 2, text: 'bir', speaker: 'Ben' },
    { start: 2.5, end: 4, text: 'iki', speaker: 'Ben' },
    { start: 4.2, end: 5, text: 'üç', speaker: 'Katılımcılar' },
    { start: 9, end: 10, text: 'dört', speaker: 'Katılımcılar' },
  ]);
  assert.deepEqual(out.map(s => s.text), ['bir iki', 'üç', 'dört']);
  assert.equal(toText(out.slice(0, 1)), '[00:00] Ben: bir iki');
});
