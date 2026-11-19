'use strict';
/**
 * Etkin kayıt oturumu: yardımcı aracı "record" komutuyla başlatır, ses seviyelerini ve kareleri
 * izler, durdurulunca toplantıyı işlenmeye hazır hale getirir. Aynı anda tek kayıt olur.
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const helper = require('./helper');
const { APPS } = require('./detector');

class Recorder extends EventEmitter {
  constructor({ lib, settings, excludeBundles = [] }) {
    super();
    this.lib = lib;
    this.settings = settings;
    this.excludeBundles = excludeBundles;
    this.current = null;
  }

  state() {
    const c = this.current;
    if (!c) return null;
    return {
      id: c.meeting.id,
      title: c.meeting.title,
      mode: c.mode,
      app: c.meeting.app,
      app_key: c.meeting.app_key,
      auto: c.auto,
      phase: c.phase,
      started_at: c.startedAt,
      elapsed_sec: c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0,
      levels: c.levels,
      shots: c.shots,
      warnings: c.warnings,
    };
  }

  /** Kaydı başlatır; yardımcı "started" dediğinde çözülür */
  start({ mode, title, app = '', app_key = '', auto = false }) {
    if (this.current) return Promise.reject(new Error('Zaten bir kayıt sürüyor'));
    const s = this.settings.all();
    const meeting = this.lib.create({ title, app, app_key, mode, created_by: auto ? 'auto' : 'manual' });
    const focus = APPS[app_key]?.focus || APPS.teams.focus;
    const args = [
      'record', '--dir', meeting.dir, '--mode', mode,
      '--mic', s.mic || 'default', '--system', s.system_audio ? '1' : '0',
      '--fps', String(s.video_fps), '--max-dim', String(s.video_max_dim),
      '--display', String(s.display || 'auto'), '--interval', String(s.shot_interval_sec),
      '--exclude', this.excludeBundles.join(','), '--focus', focus.join(','),
    ];
    const c = {
      meeting, mode, auto, phase: 'starting', startedAt: null,
      levels: { mic: 0, system: 0 }, peaks: { mic: 0, system: 0 }, shots: 0, warnings: [],
      discard: false, stopped: null, child: null,
    };
    this.current = c;

    return new Promise((resolve, reject) => {
      let started = false;
      let startError = null;
      c.child = helper.start(args, {
        onEvent: msg => {
          switch (msg.event) {
            case 'started':
              started = true;
              c.phase = 'recording';
              c.startedAt = Date.now();
              this.emit('change', this.state());
              resolve(this.state());
              break;
            case 'level':
              c.levels = { mic: msg.mic || 0, system: msg.system || 0 };
              c.peaks.mic = Math.max(c.peaks.mic, c.levels.mic);
              c.peaks.system = Math.max(c.peaks.system, c.levels.system);
              this.emit('level', { id: meeting.id, ...c.levels, elapsed_sec: Math.round((Date.now() - c.startedAt) / 1000) });
              break;
            case 'shot':
              c.shots++;
              this.emit('shot', { id: meeting.id, file: msg.file, t: msg.t });
              break;
            case 'warn':
              c.warnings.push(msg.message);
              this.emit('warn', { id: meeting.id, kind: msg.kind, message: msg.message });
              break;
            case 'error':
              startError = new helper.HelperError(msg.error, msg.kind);
              break;
            case 'stopped':
              c.stopped = msg;
              break;
          }
        },
        onExit: (code, stderr) => {
          this.current = null;
          if (!started) {
            fs.rmSync(meeting.dir, { recursive: true, force: true });
            this.emit('change', null);
            reject(startError || new Error(`Kayıt başlatılamadı (${code}) ${String(stderr || '').trim().slice(-200)}`));
            return;
          }
          this.finish(c);
        },
      });
    });
  }

  finish(c) {
    const s = this.settings.all();
    const duration = c.stopped?.duration ?? Math.round((Date.now() - c.startedAt) / 1000);
    const tooShort = c.auto && s.min_duration_sec && duration < s.min_duration_sec;
    if (c.discard || tooShort) {
      fs.rmSync(c.meeting.dir, { recursive: true, force: true });
      this.emit('change', null);
      this.emit('discarded', { id: c.meeting.id, reason: c.discard ? 'cancel' : 'short' });
      return;
    }
    const warnings = [...c.warnings];
    const files = c.stopped?.files || {};
    if (duration > 30 && s.system_audio && files.system && c.peaks.system === 0) {
      warnings.push('Karşı tarafın sesi (sistem sesi) hiç gelmedi. Sistem Ayarları → Gizlilik ve Güvenlik → Ekran ve Sistem Sesi Kaydı bölümünde Tutanak\'a izin verildiğini kontrol edin.');
    }
    if (duration > 30 && files.mic && c.peaks.mic === 0) {
      warnings.push('Mikrofondan ses gelmedi; Ayarlar\'da doğru mikrofonun seçili olduğunu kontrol edin.');
    }
    const meeting = this.lib.update(c.meeting.id, {
      status: 'processing',
      ended_at: new Date().toISOString(),
      duration_sec: Math.round(duration),
      shot_count: c.stopped?.shots ?? c.shots,
      warnings: [...new Set(warnings)],
      raw: files,
    });
    this.emit('change', null);
    this.emit('finished', meeting);
  }

  /** Kaydı bitirir; toplantı "finished" olayıyla işlenmeye gönderilir */
  stop({ discard = false } = {}) {
    const c = this.current;
    if (!c) return false;
    c.discard = c.discard || discard;
    c.phase = 'stopping';
    this.emit('change', this.state());
    try { c.child.stdin.write('stop\n'); } catch {}
    // Yardımcı yanıt vermezse
    setTimeout(() => { if (this.current === c) c.child.kill('SIGTERM'); }, 15000);
    return true;
  }
}

module.exports = { Recorder };
