'use strict';
/**
 * Geliştirme otomasyonu: örnek toplantılar oluşturur, gerçek işleme hattından geçirir ve
 * arayüzün/bildirimin ekran görüntülerini alır. Gerçek ayarlara dokunmamak için:
 *
 *   TUTANAK_DATA_DIR=.dev-data/veri TUTANAK_LIBRARY_DIR=.dev-data/kayitlar \
 *   TUTANAK_AUTOMATION=scripts/smoke.js SMOKE_OUT=/tmp/tutanak-smoke npx electron .
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ffmpeg = require('../src/ffmpeg');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function idle(jobs) {
  for (let i = 0; i < 600 && (jobs.current || jobs.queue.length); i++) await wait(250);
}

function slides(dir, ff) {
  fs.mkdirSync(dir, { recursive: true });
  const srcs = ['testsrc2=size=1920x804', 'smptehdbars=size=1920x804', 'mandelbrot=size=1920x804', 'cellauto=size=1920x804:rule=110'];
  srcs.forEach((src, i) => {
    execFileSync(ff, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-q:v', '3', path.join(dir, `${String(i * 30 + 1).padStart(6, '0')}.jpg`)]);
  });
}

async function seed({ lib, jobs, queueProcess }) {
  if (lib.list().length) return lib.list();
  const ff = ffmpeg.find();
  const at = (h, m, daysAgo = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d; };

  const a = lib.create({ title: 'Sprint planlama — Rapor modülü', app: 'Teams', app_key: 'teams', mode: 'shots', created_by: 'auto', started_at: at(10, 5) });
  for (const f of ['mikrofon.m4a', 'sistem.m4a']) fs.copyFileSync(path.join(FIX, f), path.join(a.dir, f));
  slides(path.join(a.dir, 'kareler'), ff);
  lib.update(a.id, { status: 'processing', duration_sec: 19, shot_count: 4 });

  const b = lib.create({ title: 'Müşteri demosu', app: 'Teams', app_key: 'teams', mode: 'video', started_at: at(15, 30, 1) });
  execFileSync(ff, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x804:rate=15', '-t', '19', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(b.dir, 'ekran.mp4')]);
  for (const f of ['mikrofon.m4a', 'sistem.m4a']) fs.copyFileSync(path.join(FIX, f), path.join(b.dir, f));
  lib.update(b.id, { status: 'processing', duration_sec: 19 });

  const c = lib.create({ title: 'Haftalık sync', app: 'Teams', app_key: 'teams', mode: 'audio', started_at: at(9, 0, 6) });
  for (const f of ['mikrofon.m4a', 'sistem.m4a']) fs.copyFileSync(path.join(FIX, f), path.join(c.dir, f));
  lib.update(c.id, { status: 'processing', duration_sec: 19 });

  for (const m of [a, b, c]) queueProcess(m.id);
  await idle(jobs);
  // Claude'un MCP ile yazdığı özet gibi
  lib.setText(a.id, 'ozet.md', '## Özet\nRapor ekranı tamamlandı ve test ortamına alındı. Dışa aktarma özelliği için iki gün daha gerekiyor.\n\n## Kararlar\n- Dışa aktarma cuma gününe kadar bitirilecek\n- Rapor ekranı bir sonraki sürüme girecek\n');
  lib.setText(a.id, 'notlar.md', 'Ahmet ile dışa aktarma formatlarını konuş (CSV + XLSX).');
  lib.update(a.id, { action_items: [{ text: 'Dışa aktarma özelliğini tamamla', owner: 'Ekip', due: 'Cuma', done: false, by: 'claude' }, { text: 'Rapor ekranını sürüm notlarına ekle', owner: 'Ben', due: '', done: true }] });
  return lib.list();
}

module.exports = async ctx => {
  const { app, lib, settings, jobs, queueProcess, showPrompt, command } = ctx;
  const out = process.env.SMOKE_OUT || '/tmp/tutanak-smoke';
  fs.mkdirSync(out, { recursive: true });
  const steps = (process.env.SMOKE_STEPS || 'seed,welcome,detail,prompt,settings').split(',');
  const snap = async (w, name) => {
    await wait(700);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    console.log('ekran görüntüsü:', name);
  };
  const js = code => ctx.win.webContents.executeJavaScript(code);
  // Bildirim penceresi saydam (vibrancy) olduğu için gerçek ekrandan alınır
  const screen = async name => {
    await wait(900);
    const b = ctx.promptWin.getBounds();
    execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${b.x - 10},${b.y - 6},${b.width + 20},${b.height + 16}`, path.join(out, `${name}-ekran.png`)]);
  };

  const meetings = await seed({ lib, jobs, queueProcess });
  console.log('toplantılar:', meetings.map(m => `${m.title} [${m.status}, döküm ${m.transcript?.status}]`).join(' | '));

  if (steps.includes('welcome')) {
    settings.set({ onboarded: false });
    command('go', '#/');
    await wait(800);
    await js('location.reload()');
    await wait(1500);
    await snap(ctx.win, '01-karsilama');
  }
  settings.set({ onboarded: true });

  if (steps.includes('detail')) {
    const a = lib.list().find(m => m.mode === 'shots');
    await js(`location.hash = '#/m/${a.id}'; location.reload()`);
    await wait(1800);
    await snap(ctx.win, '02-toplanti-doküm');
    await js(`document.querySelector('[data-tab="shots"]').click()`);
    await snap(ctx.win, '03-kareler');
    await js(`document.querySelector('[data-tab="summary"]').click()`);
    await snap(ctx.win, '04-ozet');
    const b = lib.list().find(m => m.mode === 'video');
    await js(`location.hash = '#/m/${b.id}'`);
    await wait(1200);
    await snap(ctx.win, '05-video');
  }

  if (steps.includes('prompt')) {
    showPrompt({ kind: 'ask', app: 'Teams', app_key: 'teams', title: 'Haftalık Sync | Ürün ekibi', mode: settings.get('mode'), modes: [{ id: 'video', label: 'Ekran videosu' }, { id: 'audio', label: 'Yalnızca ses' }, { id: 'shots', label: 'Ses + ekran görüntüsü' }], timeout: 45 });
    await wait(1200);
    await snap(ctx.promptWin, '06-bildirim-soru');
    await screen('06-bildirim-soru');
    showPrompt({ kind: 'recording', title: 'Haftalık Sync | Ürün ekibi', mode: 'shots', mode_label: 'Ses + ekran görüntüsü', auto: false });
    await snap(ctx.promptWin, '07-bildirim-kayit');
    await screen('07-bildirim-kayit');
    showPrompt({ kind: 'finished', id: 'x', title: 'Haftalık Sync | Ürün ekibi', duration: '42:10', transcribing: true, warnings: [] });
    await snap(ctx.promptWin, '08-bildirim-bitti');
    await screen('08-bildirim-bitti');
    ctx.hidePrompt();
  }

  if (steps.includes('settings')) {
    await js(`location.hash = '#/ayarlar'`);
    await wait(2000);
    await snap(ctx.win, '09-ayarlar');
  }

  if (steps.includes('archive')) {
    const a = lib.list().find(m => m.mode === 'shots' && m.status === 'ready');
    ctx.queueArchive(a.id);
    await wait(300);
    await js(`location.hash = '#/m/${a.id}'`);
    await snap(ctx.win, '10-arsivleniyor');
    await idle(jobs);
    await wait(800);
    await snap(ctx.win, '11-arsivlendi');
  }
  if (steps.includes('e2e')) {
    // Gerçek kayıt: algılanan görüşme → bildirimde "Kaydet" → görüşme biter → otomatik durur → işlenir.
    // İzin penceresi çıkmasın diye mikrofon ve sistem sesi kapalı.
    settings.set({ mic: 'none', system_audio: false, shot_interval_sec: 4, ask: 'ask', mode: 'shots', auto_stop: true });
    const before = new Set(lib.list().map(m => m.id));
    await ctx.onCallStart({ key: 'teams', app: ctx.APPS.teams });
    await wait(1200);
    await screen('12-e2e-soru');
    await ctx.promptWin.webContents.executeJavaScript(`document.querySelector('[data-a="record"]').click()`);
    for (let i = 0; i < 40 && ctx.recorder.state()?.phase !== 'recording'; i++) await wait(250);
    console.log('kayıt durumu:', JSON.stringify(ctx.recorder.state()));
    await wait(10000);
    await snap(ctx.win, '13-e2e-kayit');
    ctx.onCallEnd({ key: 'teams' });
    for (let i = 0; i < 80 && ctx.recorder.current; i++) await wait(250);
    await wait(500);
    await idle(jobs);
    const made = lib.list().filter(m => !before.has(m.id));
    for (const m of made) console.log('e2e toplantı:', m.title, m.status, 'kare', lib.shots(m.id).length, 'süre', m.duration_sec, 'uyarılar', JSON.stringify(m.warnings));

    await ctx.startRecording({ mode: 'video', title: 'E2E video', app: '', app_key: '' });
    await wait(6000);
    ctx.recorder.stop();
    for (let i = 0; i < 80 && ctx.recorder.current; i++) await wait(250);
    await wait(500);
    await idle(jobs);
    const v = lib.list().find(m => m.title === 'E2E video');
    console.log('e2e video:', v?.status, v?.media, v && fs.existsSync(path.join(v.dir, 'kayit.mp4')), v?.duration_sec, JSON.stringify(v?.warnings));
    await js(`location.hash = '#/m/${v.id}'`);
    await snap(ctx.win, '14-e2e-video');
  }
  app.exit(0);
};
