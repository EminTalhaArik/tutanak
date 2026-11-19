'use strict';
/**
 * Döküm yardımcıları: mikrofon (ben) ve sistem sesi (katılımcılar) dökümlerini birleştirme,
 * hoparlörden mikrofona sızan yankıları ayıklama ve metin biçimleri.
 */

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function words(text) {
  return String(text || '').toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** İki metnin kelime kümesi benzerliği (0…1) */
function similarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Hoparlörle konuşulduğunda karşı tarafın sesi mikrofona da girer; aynı anda ve büyük ölçüde
 * aynı kelimelerle sistem sesinde de geçen mikrofon parçaları atılır.
 */
function dropEchoes(mine, others) {
  return mine.filter(m => {
    const dur = Math.max(0.5, m.end - m.start);
    return !others.some(o => overlap(m, o) >= dur * 0.3 && similarity(m.text, o.text) >= 0.6);
  });
}

/** İki izi konuşmacı etiketiyle tek, zamana göre sıralı listeye çevirir */
function mergeTracks({ mine = [], others = [], meLabel = 'Ben', othersLabel = 'Katılımcılar' }) {
  const kept = dropEchoes(mine, others);
  return [
    ...kept.map(s => ({ ...s, speaker: meLabel })),
    ...others.map(s => ({ ...s, speaker: othersLabel })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Aynı konuşmacının art arda, kısa aralıklı parçalarını okunabilirlik için birleştirir */
function compact(segments, { maxGap = 1.2, maxChars = 600 } = {}) {
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end <= maxGap && last.text.length + s.text.length < maxChars) {
      last.text = `${last.text} ${s.text}`;
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function toText(segments, { from = null, to = null } = {}) {
  return segments
    .filter(s => (from == null || s.end >= from) && (to == null || s.start <= to))
    .map(s => `[${formatTime(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`)
    .join('\n');
}

function wordTotal(segments) {
  return segments.reduce((n, s) => n + words(s.text).length, 0);
}

module.exports = { formatTime, similarity, dropEchoes, mergeTracks, compact, toText, wordTotal, words };
