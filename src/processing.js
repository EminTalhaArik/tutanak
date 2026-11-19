'use strict';
/**
 * Kayıt sonrası işlemler:
 *  1. Birleştirme: sistem sesi + mikrofon tek bir ses izine karıştırılır (video kipinde ekran
 *     videosuyla aynı dosyaya), oynatıcı ve paylaşım için tek dosya olur.
 *  2. Döküm: izler ayrı ayrı (mikrofon = "Ben", sistem sesi = "Katılımcılar") macOS'un cihaz
 *     üzerindeki konuşma tanımasıyla dökülür ve birleştirilir.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('./ffmpeg');
const helper = require('./helper');
const { mergeTracks, compact, toText, wordTotal } = require('./transcript');
const { TRANSCRIPT, TRANSCRIPT_TXT } = require('./library');

// Ham izlerin başlangıçları kaydın başına hizalanır (geç başlayan izin başı sessizlikle doldurulur)
const ALIGN = 'aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** first: ilk ses girdisinin ffmpeg girdi sırası (video kipinde 0 numara ekran videosudur) */
function audioGraph(count, first = 0) {
  if (count === 1) return { filter: `[${first}:a]${ALIGN}[out]`, label: '[out]' };
  return {
    filter: `[${first}:a]${ALIGN}[a0];[${first + 1}:a]${ALIGN}[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97[out]`,
    label: '[out]',
  };
}

function exists(dir, name) {
  return fs.existsSync(path.join(dir, name)) && fs.statSync(path.join(dir, name)).size > 0;
}

/** Ham izlerden oynatılacak kaydı üretir; meeting.media alanını döndürür */
async function mix(meeting, { ff, onProgress } = {}) {
  const dir = meeting.dir;
  const audio = ['sistem.m4a', 'mikrofon.m4a'].filter(f => exists(dir, f));
  const hasVideo = exists(dir, 'ekran.mp4');
  const duration = meeting.duration_sec || 0;

  if (meeting.mode === 'video') {
    if (!hasVideo) throw new Error('Ekran videosu kaydedilemedi');
    const out = path.join(dir, 'kayit.mp4');
    const tmp = path.join(dir, '.kayit.tmp.mp4');
    if (!audio.length) {
      fs.renameSync(path.join(dir, 'ekran.mp4'), out);
      return 'kayit.mp4';
    }
    const g = audioGraph(audio.length, 1);
    await ffmpeg.run(ff.bin, [
      '-i', path.join(dir, 'ekran.mp4'), ...audio.flatMap(f => ['-i', path.join(dir, f)]),
      '-filter_complex', g.filter,
      '-map', '0:v:0', '-map', g.label,
      '-c:v', 'copy', '-c:a', ff.aac, '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', tmp,
    ], { duration, onProgress });
    fs.renameSync(tmp, out);
    fs.rmSync(path.join(dir, 'ekran.mp4'), { force: true });
    return 'kayit.mp4';
  }

  if (!audio.length) return null; // yalnızca kareler kaldı
  const g = audioGraph(audio.length);
  const tmp = path.join(dir, '.ses.tmp.m4a');
  await ffmpeg.run(ff.bin, [
    ...audio.flatMap(f => ['-i', path.join(dir, f)]),
    '-filter_complex', g.filter, '-map', g.label,
    '-ac', '1', '-c:a', ff.aac, '-b:a', '96k', '-movflags', '+faststart', tmp,
  ], { duration, onProgress });
  fs.renameSync(tmp, path.join(dir, 'ses.m4a'));
  return 'ses.m4a';
}

/** Bir ses dosyasını 16 kHz mono WAV'a çevirip döker */
async function transcribeFile(ff, file, locale, onProgress) {
  const wav = path.join(os.tmpdir(), `tutanak-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    await ffmpeg.run(ff.bin, ['-i', file, '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const res = await helper.run(['transcribe', '--input', wav, '--locale', locale], {
      onEvent: m => { if (m.event === 'progress' && m.duration) onProgress?.(m.t / m.duration); },
    });
    return res;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

/**
 * Dökümü üretir ve transkript.json/.txt dosyalarına yazar.
 * Ham izler duruyorsa konuşmacılar ayrılır; arşivlenmiş kayıtta birleşik ses dökülür.
 */
async function transcribe(meeting, settings, { ff, onProgress } = {}) {
  const dir = meeting.dir;
  const locale = settings.transcript_locale || 'tr-TR';
  let split = settings.split_speakers && exists(dir, 'mikrofon.m4a') && exists(dir, 'sistem.m4a');
  // Sistem sesi sessiz kaydedildiyse (ör. izin yokken) karşı tarafın sesi yalnızca hoparlörden mikrofona
  // sızmıştır; her şeyi "Ben" diye etiketlemek yanıltıcı olur, konuşmacısız dökülür.
  if (split) {
    const peak = await ffmpeg.maxVolume(ff.bin, path.join(dir, 'sistem.m4a'));
    if (peak != null && peak < -70) split = false;
  }
  let segments;
  let engine = null;
  if (split) {
    const mine = await transcribeFile(ff, path.join(dir, 'mikrofon.m4a'), locale, p => onProgress?.(p / 2));
    const others = await transcribeFile(ff, path.join(dir, 'sistem.m4a'), locale, p => onProgress?.(0.5 + p / 2));
    engine = mine.engine || others.engine;
    segments = compact(mergeTracks({
      mine: mine.segments || [],
      others: others.segments || [],
      meLabel: settings.me_label || 'Ben',
      othersLabel: settings.others_label || 'Katılımcılar',
    }));
  } else {
    const source = ['mikrofon.m4a', 'sistem.m4a'].filter(f => exists(dir, f));
    const file = meeting.media && exists(dir, meeting.media) ? meeting.media : source.length === 1 ? source[0] : null;
    if (!file) throw new Error('Dökülecek ses bulunamadı');
    const res = await transcribeFile(ff, path.join(dir, file), locale, onProgress);
    engine = res.engine;
    const label = file === 'mikrofon.m4a' ? settings.me_label : file === 'sistem.m4a' ? settings.others_label : null;
    segments = compact((res.segments || []).map(s => ({ ...s, speaker: label })));
  }
  const doc = { version: 1, engine, locale, created_at: new Date().toISOString(), split_speakers: split, segments };
  fs.writeFileSync(path.join(dir, TRANSCRIPT), JSON.stringify(doc, null, 1));
  const head = `${meeting.title}\n${new Date(meeting.started_at).toLocaleString('tr-TR')}\n\n`;
  fs.writeFileSync(path.join(dir, TRANSCRIPT_TXT), head + toText(segments) + '\n');
  return { status: 'done', engine, locale, segments: segments.length, words: wordTotal(segments), split_speakers: split, updated_at: doc.created_at };
}

module.exports = { mix, transcribe, transcribeFile };
