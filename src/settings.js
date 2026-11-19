'use strict';
/**
 * Ayarlar: <veri klasörü>/ayarlar.json. MCP sunucusu da kayıt klasörünü buradan öğrenir.
 */
const fs = require('node:fs');
const path = require('node:path');
const { dataDir, defaultLibraryDir } = require('./paths');

const MODES = ['video', 'audio', 'shots'];
const MODE_LABELS = { video: 'Ekran videosu', audio: 'Yalnızca ses', shots: 'Ses + ekran görüntüsü' };
const ASK = ['ask', 'always', 'never'];
const ARCHIVE_PROFILES = ['kucuk', 'dengeli'];

const DEFAULTS = {
  library_dir: '',            // boşsa ~/Movies/Tutanak
  archive_dir: '',            // boşsa arşivlenen toplantı yerinde kalır
  mode: 'shots',
  ask: 'ask',                 // ask: bildirimle sor · always: sormadan kaydet · never: algılama kapalı
  prompt_timeout_sec: 45,
  apps: ['teams'],
  auto_stop: true,
  end_grace_sec: 20,          // uygulama sesi bıraktıktan bu kadar sonra toplantı bitmiş sayılır
  mic: 'default',             // default | none | aygıt kimliği
  system_audio: true,
  shot_interval_sec: 30,
  video_fps: 15,
  video_max_dim: 1920,
  display: 'auto',            // auto (toplantı penceresinin olduğu ekran) | main | ekran kimliği
  auto_transcribe: true,
  transcript_locale: 'tr-TR',
  split_speakers: true,       // mikrofon = Ben, sistem sesi = Katılımcılar
  me_label: 'Ben',
  others_label: 'Katılımcılar',
  archive_profile: 'kucuk',
  auto_archive_days: 0,       // 0 = kapalı
  min_duration_sec: 20,       // bundan kısa otomatik kayıtlar (ör. yalnızca bekleme ekranı) silinir
  ffmpeg_path: '',
  open_at_login: null,
  onboarded: false,
};

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Bilinmeyen anahtarları atar, değerleri sınırlar */
function sanitize(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    switch (k) {
      case 'mode': if (MODES.includes(v)) out[k] = v; break;
      case 'ask': if (ASK.includes(v)) out[k] = v; break;
      case 'archive_profile': if (ARCHIVE_PROFILES.includes(v)) out[k] = v; break;
      case 'apps': if (Array.isArray(v)) out[k] = [...new Set(v.filter(x => typeof x === 'string'))]; break;
      case 'prompt_timeout_sec': out[k] = clampInt(v, 5, 600, DEFAULTS[k]); break;
      case 'end_grace_sec': out[k] = clampInt(v, 5, 600, DEFAULTS[k]); break;
      case 'shot_interval_sec': out[k] = clampInt(v, 5, 600, DEFAULTS[k]); break;
      case 'video_fps': out[k] = clampInt(v, 1, 60, DEFAULTS[k]); break;
      case 'video_max_dim': out[k] = clampInt(v, 640, 3840, DEFAULTS[k]); break;
      case 'auto_archive_days': out[k] = clampInt(v, 0, 3650, DEFAULTS[k]); break;
      case 'min_duration_sec': out[k] = clampInt(v, 0, 600, DEFAULTS[k]); break;
      case 'auto_stop': case 'system_audio': case 'auto_transcribe': case 'split_speakers': case 'onboarded':
        out[k] = Boolean(v); break;
      case 'open_at_login': out[k] = v == null ? null : Boolean(v); break;
      default: out[k] = v == null ? '' : String(v).trim();
    }
  }
  return out;
}

class Settings {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'ayarlar.json');
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      this.values = { ...DEFAULTS, ...sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8'))) };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Tutanak ayarları okunamadı:', e.message);
    }
    return this.values;
  }

  get(key) { return this.values[key]; }

  all() {
    return { ...this.values, library_dir: this.libraryDir() };
  }

  libraryDir() {
    return this.values.library_dir || defaultLibraryDir();
  }

  set(patch) {
    this.values = { ...this.values, ...sanitize(patch) };
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
    fs.renameSync(tmp, this.file);
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS, MODES, MODE_LABELS, ARCHIVE_PROFILES, sanitize };
