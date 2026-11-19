'use strict';
/**
 * Arşivleme: toplantıyı küçültür ve (ayarlıysa) arşiv klasörüne taşır.
 *  - Ekran videosu HEVC'ye, düşük kare hızına ve daha küçük çözünürlüğe çevrilir
 *    (toplantı ekranları çoğunlukla durağan olduğundan çok iyi sıkışır).
 *  - Ses mono, düşük bit hızlı AAC'ye çevrilir (konuşma için yeterli).
 *  - Ekran görüntüleri yeniden sıkıştırılır, birbirinin aynısı olan ardışık kareler atılır.
 *  - Ham izler (sistem.m4a, mikrofon.m4a) silinir; döküm yoksa önce döküm çıkarılır.
 * Yeni dosya önce geçici adla üretilir, süresi doğrulanınca eskisinin yerine konur.
 */
const fs = require('node:fs');
const path = require('node:path');
const ffmpeg = require('./ffmpeg');
const helper = require('./helper');
const { dirSize, RAW_FILES, SHOTS } = require('./library');

const PROFILES = {
  kucuk: {
    label: 'Küçük (en çok yer kazandırır)',
    video: { maxDim: 1280, fps: 5, crf: 32 },
    audioKbps: 32,
    shots: { quality: 0.45, maxDim: 1440, dedupe: 0.03 },
  },
  dengeli: {
    label: 'Dengeli (daha net görüntü)',
    video: { maxDim: 1920, fps: 10, crf: 28 },
    audioKbps: 64,
    shots: { quality: 0.6, maxDim: 1920, dedupe: 0.02 },
  },
};

const BUSY = ['recording', 'processing', 'archiving'];

function size(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

async function replaceIfGood(ff, src, tmp) {
  const [a, b] = await Promise.all([ffmpeg.duration(ff.probe, src), ffmpeg.duration(ff.probe, tmp)]);
  if (ff.probe && a > 0 && Math.abs(a - b) > Math.max(3, a * 0.03)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Sıkıştırılan dosyanın süresi tutmadı (${a.toFixed(0)} sn → ${b.toFixed(0)} sn); orijinal korundu`);
  }
  if (size(tmp) === 0 || size(tmp) >= size(src)) {
    fs.rmSync(tmp, { force: true }); // zaten küçük: orijinal kalsın
    return false;
  }
  fs.renameSync(tmp, src);
  return true;
}

function videoArgs(ff, p) {
  const D = p.video.maxDim;
  const vf = `fps=${p.video.fps},scale=w='if(gte(iw,ih),trunc(min(${D},iw)/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(${D},ih)/2)*2)',format=yuv420p`;
  const codec = ff.x265
    ? ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(p.video.crf), '-tag:v', 'hvc1', '-x265-params', 'log-level=error']
    : ff.hevc_vt
      ? ['-c:v', 'hevc_videotoolbox', '-q:v', '40', '-tag:v', 'hvc1']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(p.video.crf - 4)];
  return ['-vf', vf, ...codec];
}

function moveDir(src, destRoot) {
  fs.mkdirSync(destRoot, { recursive: true });
  const dest = path.join(destRoot, path.basename(src));
  if (fs.existsSync(dest)) throw new Error(`Arşiv klasöründe aynı adlı klasör var: ${dest}`);
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return dest;
}

/**
 * @param {import('./library').Library} lib
 * @param {object} opts  ff (ffmpeg.info), settings, onProgress(step, pct), transcribe(meeting) → Promise
 */
async function archiveMeeting(lib, id, { ff, settings, onProgress = () => {}, transcribe = null }) {
  let m = lib.meta(id);
  if (BUSY.includes(m.status)) throw new Error('Bu toplantı şu anda kaydediliyor ya da işleniyor');
  if (!ff?.ok) throw new Error('Arşivleme için ffmpeg gerekli (brew install ffmpeg)');
  const profile = PROFILES[settings.archive_profile] || PROFILES.kucuk;
  const previous = m.status;
  const before = dirSize(m.dir);
  lib.update(id, { status: 'archiving', archive_error: null });
  try {
    // Ham izler silinmeden önce konuşmacılı döküm alınsın
    if (transcribe && settings.auto_transcribe && m.has_audio !== false && m.transcript?.status !== 'done') {
      onProgress('Döküm çıkarılıyor', 0);
      try { await transcribe(m); } catch (e) { console.error('Arşiv öncesi döküm:', e.message); }
      m = lib.meta(id);
    }
    const media = m.media && path.join(m.dir, m.media);
    if (media && fs.existsSync(media)) {
      const tmp = path.join(m.dir, `.arsiv.tmp${path.extname(media)}`);
      const duration = m.duration_sec || await ffmpeg.duration(ff.probe, media);
      const progress = p => onProgress(m.mode === 'video' ? 'Video sıkıştırılıyor' : 'Ses sıkıştırılıyor', p);
      const audio = ['-c:a', ff.aac, '-b:a', `${profile.audioKbps}k`, '-ac', '1'];
      if (m.mode === 'video') {
        await ffmpeg.run(ff.bin, ['-i', media, '-map', '0:v:0', '-map', '0:a:0?', ...videoArgs(ff, profile), ...audio, '-movflags', '+faststart', tmp], { duration, onProgress: progress });
      } else {
        await ffmpeg.run(ff.bin, ['-i', media, '-vn', ...audio, '-movflags', '+faststart', tmp], { duration, onProgress: progress });
      }
      await replaceIfGood(ff, media, tmp);
    }
    let removedShots = 0;
    if (fs.existsSync(path.join(m.dir, SHOTS))) {
      onProgress('Ekran görüntüleri küçültülüyor', 0);
      const s = profile.shots;
      const res = await helper.run(['shrink-images', '--dir', path.join(m.dir, SHOTS), '--quality', String(s.quality), '--max-dim', String(s.maxDim), '--dedupe', String(s.dedupe)]);
      removedShots = res.removed || 0;
    }
    // Oynatılacak birleşik kayıt varsa ham izlere gerek kalmaz
    if (m.media && fs.existsSync(path.join(m.dir, m.media))) {
      for (const f of RAW_FILES) fs.rmSync(path.join(m.dir, f), { force: true });
    }
    const after = dirSize(m.dir);
    m = lib.update(id, {
      status: 'archived',
      shot_count: removedShots ? Math.max(0, (m.shot_count || 0) - removedShots) : m.shot_count,
      archive: { at: new Date().toISOString(), profile: settings.archive_profile, before_bytes: before, after_bytes: after, removed_shots: removedShots },
    });
    const target = settings.archive_dir;
    if (target && path.resolve(path.dirname(m.dir)) !== path.resolve(target)) {
      onProgress('Arşiv klasörüne taşınıyor', 1);
      moveDir(m.dir, target);
    }
    onProgress('Tamamlandı', 1);
    return { id, before, after };
  } catch (e) {
    try { lib.update(id, { status: previous, archive_error: e.message }); } catch {}
    throw e;
  }
}

/** Otomatik arşivlenecek (N günden eski, hazır) toplantılar */
function dueForArchive(meetings, days, now = Date.now()) {
  if (!days) return [];
  const limit = now - days * 86400000;
  return meetings.filter(m => m.status === 'ready' && new Date(m.started_at).getTime() < limit);
}

module.exports = { archiveMeeting, dueForArchive, PROFILES, moveDir };
