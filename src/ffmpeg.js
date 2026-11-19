'use strict';
/**
 * ffmpeg/ffprobe (Homebrew): izleri birleştirme, döküm için WAV'a çevirme ve arşiv sıkıştırması.
 */
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

let cached = null;

function find(custom = '') {
  if (custom && fs.existsSync(custom)) return custom;
  const fromPath = (process.env.PATH || '').split(':').map(d => path.join(d, 'ffmpeg'));
  return [...CANDIDATES, ...fromPath].find(p => fs.existsSync(p)) || null;
}

/** ffmpeg yolu ve hangi kodlayıcıların bulunduğu */
async function info(custom = '') {
  const bin = find(custom);
  if (!bin) return { ok: false };
  if (cached?.bin === bin) return cached;
  const probe = path.join(path.dirname(bin), 'ffprobe');
  const encoders = await new Promise(resolve => {
    execFile(bin, ['-hide_banner', '-encoders'], { maxBuffer: 4 << 20 }, (e, out) => resolve(e ? '' : out));
  });
  const has = name => new RegExp(`\\s${name}\\s`).test(encoders);
  cached = {
    ok: true,
    bin,
    probe: fs.existsSync(probe) ? probe : null,
    aac: has('aac_at') ? 'aac_at' : 'aac',
    x265: has('libx265'),
    hevc_vt: has('hevc_videotoolbox'),
    x264: has('libx264'),
  };
  return cached;
}

/** ffmpeg'i çalıştırır; duration verilirse onProgress(0…1) çağrılır */
function run(bin, args, { duration = 0, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats', ...args]);
    let err = '';
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.on('data', d => { err = (err + d).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg başarısız (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

/** Saniye cinsinden süre; okunamazsa 0 */
function duration(probe, file) {
  if (!probe) return Promise.resolve(0);
  return new Promise(resolve => {
    execFile(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], (e, out) => {
      resolve(e ? 0 : Number(String(out).trim()) || 0);
    });
  });
}

/** Ses izini en yüksek seviyesi (dB); sessiz kayıtları yakalamak için */
function maxVolume(bin, file) {
  return new Promise(resolve => {
    execFile(bin, ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 8 << 20 }, (e, _out, err) => {
      const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(String(err));
      resolve(m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : null);
    });
  });
}

module.exports = { find, info, run, duration, maxVolume };
