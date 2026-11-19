'use strict';
/**
 * Toplantı kütüphanesi: her toplantı kayıt klasöründe ayrı bir alt klasördür.
 *
 *   2026-11-03_1405_teams/
 *     meeting.json          üst bilgiler (başlık, süre, kip, durum, eylem maddeleri…)
 *     kayit.mp4 | ses.m4a   oynatılacak kayıt
 *     sistem.m4a, mikrofon.m4a, ekran.mp4   ham izler (arşivlenince silinir)
 *     kareler/000030.jpg    ekran görüntüleri (dosya adı = kaydın kaçıncı saniyesi)
 *     transkript.json/.txt  döküm
 *     notlar.md, ozet.md    kullanıcı notları ve (çoğunlukla Claude'un yazdığı) özet
 *
 * Masaüstü uygulaması ve MCP sunucusu aynı klasörleri okur/yazar; meeting.json her
 * değişiklikte geçici dosya + yeniden adlandırma ile yazılır.
 */
const fs = require('node:fs');
const path = require('node:path');

const META = 'meeting.json';
const NOTES = 'notlar.md';
const SUMMARY = 'ozet.md';
const TRANSCRIPT = 'transkript.json';
const TRANSCRIPT_TXT = 'transkript.txt';
const SHOTS = 'kareler';
const RAW_FILES = ['sistem.m4a', 'mikrofon.m4a', 'ekran.mp4'];
const ID_RE = /^[\w.-]+$/;

class NotFoundError extends Error {}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) { try { total += fs.statSync(p).size; } catch {} }
  }
  return total;
}

const pad = n => String(n).padStart(2, '0');

function slug(text) {
  return String(text || '').toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }[c]))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

function shotTime(file) {
  const m = /^(\d+)\.jpg$/i.exec(file);
  return m ? Number(m[1]) : null;
}

class Library {
  /** @param {() => {library: string, archive?: string}} dirs */
  constructor(dirs) {
    this.dirs = dirs;
    this.textCache = new Map();
  }

  roots() {
    const d = this.dirs();
    return [...new Set([d.library, d.archive].filter(Boolean))];
  }

  /** Toplantının klasörü; yoksa null */
  locate(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    for (const root of this.roots()) {
      const dir = path.join(root, id);
      if (fs.existsSync(path.join(dir, META))) return dir;
    }
    return null;
  }

  dirOf(id) {
    const dir = this.locate(id);
    if (!dir) throw new NotFoundError(`Toplantı bulunamadı: ${id}`);
    return dir;
  }

  /** Klasör içindeki bir dosyanın güvenli tam yolu (klasör dışına çıkılamaz) */
  file(id, rel) {
    const dir = this.dirOf(id);
    const p = path.normalize(path.join(dir, rel));
    if (!p.startsWith(dir + path.sep)) throw new NotFoundError('Geçersiz dosya yolu');
    return p;
  }

  meta(id) {
    const dir = this.dirOf(id);
    const m = readJson(path.join(dir, META));
    if (!m) throw new NotFoundError(`meeting.json okunamadı: ${id}`);
    return { ...m, id, dir };
  }

  /** Tüm toplantılar, en yeniden eskiye */
  list({ sizes = true } = {}) {
    const out = [];
    for (const root of this.roots()) {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
        const dir = path.join(root, e.name);
        const m = readJson(path.join(dir, META));
        if (!m) continue;
        const item = { ...m, id: e.name, dir, in_archive_dir: root !== this.dirs().library };
        item.has_notes = fs.existsSync(path.join(dir, NOTES)) && fs.statSync(path.join(dir, NOTES)).size > 0;
        item.has_summary = fs.existsSync(path.join(dir, SUMMARY)) && fs.statSync(path.join(dir, SUMMARY)).size > 0;
        if (sizes) item.size_bytes = dirSize(dir);
        out.push(item);
      }
    }
    return out.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  }

  /** Klasörü oluşturur ve ilk meeting.json'ı yazar */
  create({ title, app = '', app_key = '', mode, created_by = 'manual', started_at = new Date() }) {
    const root = this.dirs().library;
    fs.mkdirSync(root, { recursive: true });
    const d = new Date(started_at);
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${app_key ? `_${slug(app_key)}` : ''}`;
    let id = base;
    for (let i = 2; fs.existsSync(path.join(root, id)); i++) id = `${base}-${i}`;
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      version: 1,
      title: title || 'Toplantı',
      app,
      app_key,
      mode,
      created_by,
      started_at: d.toISOString(),
      ended_at: null,
      duration_sec: 0,
      status: 'recording',
      media: null,
      shot_count: 0,
      warnings: [],
      transcript: { status: 'none' },
      action_items: [],
      tags: [],
    };
    writeJsonAtomic(path.join(dir, META), meta);
    return { ...meta, id, dir };
  }

  /** patch nesnesi ya da (meta) => patch işleviyle günceller */
  update(id, patch) {
    const dir = this.dirOf(id);
    const file = path.join(dir, META);
    const current = readJson(file) || {};
    const change = typeof patch === 'function' ? patch(current) : patch;
    const next = { ...current, ...change, updated_at: new Date().toISOString() };
    delete next.id;
    delete next.dir;
    writeJsonAtomic(file, next);
    return { ...next, id, dir };
  }

  text(id, name) {
    try { return fs.readFileSync(this.file(id, name), 'utf8'); } catch { return ''; }
  }

  setText(id, name, text) {
    if (![NOTES, SUMMARY].includes(name)) throw new Error('Yalnızca notlar ve özet yazılabilir');
    fs.writeFileSync(this.file(id, name), String(text ?? ''));
    this.update(id, {});
  }

  shots(id) {
    let files = [];
    try { files = fs.readdirSync(this.file(id, SHOTS)); } catch { return []; }
    return files.map(f => ({ file: `${SHOTS}/${f}`, t: shotTime(f) })).filter(s => s.t != null).sort((a, b) => a.t - b.t);
  }

  transcript(id) {
    return readJson(this.file(id, TRANSCRIPT));
  }

  /** Arama için döküm + not + özet metni (değişmedikçe önbellekten) */
  searchText(id) {
    const dir = this.dirOf(id);
    const stamp = [TRANSCRIPT, NOTES, SUMMARY, META].map(f => {
      try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; }
    }).join(':');
    const hit = this.textCache.get(id);
    if (hit && hit.stamp === stamp) return hit.text;
    const t = this.transcript(id);
    const m = readJson(path.join(dir, META)) || {};
    const text = [
      m.title, m.app, (m.tags || []).join(' '), (m.action_items || []).map(a => a.text).join(' '),
      this.text(id, NOTES), this.text(id, SUMMARY),
      ...(t?.segments || []).map(s => s.text),
    ].join('\n').toLocaleLowerCase('tr');
    this.textCache.set(id, { stamp, text });
    return text;
  }

  /** Arşivlenmiş ham izler dahil tüm dosyaları */
  files(id) {
    const dir = this.dirOf(id);
    const out = {};
    for (const f of ['kayit.mp4', 'ses.m4a', ...RAW_FILES, TRANSCRIPT, TRANSCRIPT_TXT, NOTES, SUMMARY]) {
      try { out[f] = fs.statSync(path.join(dir, f)).size; } catch {}
    }
    return out;
  }
}

module.exports = {
  Library, NotFoundError, dirSize, writeJsonAtomic, readJson, slug,
  META, NOTES, SUMMARY, TRANSCRIPT, TRANSCRIPT_TXT, SHOTS, RAW_FILES,
};
