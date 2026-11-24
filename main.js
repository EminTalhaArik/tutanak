'use strict';
/**
 * Tutanak — Electron ana süreci.
 *
 * Arka planda Teams (ve ayarlardaki diğer uygulamaların) görüşmelerini algılar, sağ üstte
 * "Kaydedilsin mi?" bildirimi gösterir; onaylanırsa ayarlanan kipte (ekran videosu / yalnızca ses /
 * ses + 30 sn'de bir ekran görüntüsü) kaydeder. Kayıt bitince izler birleştirilir ve cihaz
 * üzerinde döküm çıkarılır. Arayüz app://tutanak/ adresinden yüklenir; kayıtlar /media/<id>/…
 * altından (aralık isteği destekli) sunulur. Aynı kütüphaneyi Claude'un bağlandığı MCP sunucusu
 * (mcp-server.js) da okur.
 */
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, screen, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const { Settings, MODE_LABELS, MODES } = require('./src/settings');
const { Library, dirSize, NOTES, SUMMARY, NotFoundError } = require('./src/library');
const { Detector, APPS, meetingTitle } = require('./src/detector');
const { Recorder } = require('./src/recorder');
const { Jobs } = require('./src/jobs');
const { mix, transcribe } = require('./src/processing');
const { archiveMeeting, dueForArchive, PROFILES } = require('./src/archive');
const ffmpeg = require('./src/ffmpeg');
const helper = require('./src/helper');
const claude = require('./src/claude');
const { helperPath } = require('./src/paths');
const { formatTime } = require('./src/transcript');

const STATIC = path.join(__dirname, 'static');
const ORIGIN = 'app://tutanak';
const AUTO_ARCHIVE_MS = 6 * 60 * 60 * 1000;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

app.commandLine.appendSwitch('lang', 'tr-TR');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
// Ayrı veri klasörüyle (geliştirme/otomasyon) çalışırken kurulu Tutanak açıksa tek örnek kilidine takılmasın
if (process.env.TUTANAK_DATA_DIR) app.setPath('userData', path.join(process.env.TUTANAK_DATA_DIR, 'electron'));
if (!app.requestSingleInstanceLock()) app.quit();

const settings = new Settings();
const lib = new Library(() => ({ library: settings.libraryDir(), archive: settings.get('archive_dir') }));
const jobs = new Jobs();
let recorder;
let detector;
let win = null;
let tray = null;
let promptWin = null;
let promptData = null;
let pendingCall = null;   // algılanan, henüz kaydedilmeyen görüşme
let quitting = false;

/** Kendi pencerelerimiz (bildirim, ana pencere) kayda girmesin diye paket kimliği */
function ownBundleId() {
  try {
    const plist = fs.readFileSync(path.join(path.dirname(process.execPath), '..', 'Info.plist'), 'utf8');
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ app:// protokolü

async function serveFile(file, request) {
  const stat = await fs.promises.stat(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...base, 'Content-Length': String(stat.size) } });
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === 'media' && parts.length >= 3) {
      return await serveFile(lib.file(parts[1], parts.slice(2).join('/')), request);
    }
  } catch (e) {
    return new Response(e instanceof NotFoundError ? 'Bulunamadı' : e.message, { status: 404 });
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(STATIC, rel));
  if (!file.startsWith(STATIC + path.sep) || !fs.existsSync(file)) return new Response('Bulunamadı', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

// ------------------------------------------------------------ pencereler

function createWindow() {
  app.dock?.show();
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: 'Tutanak',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f10' : '#f6f6f3',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
    // Pencere kapalıyken yalnızca menü çubuğunda dursun
    if (!quitting) app.dock?.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.loadURL(`${ORIGIN}/index.html`);
}

/** Pencereyi öne getirir ve (yüklendikten sonra) arayüzde bir komut çalıştırır. */
function showWindow(script) {
  const run = () => script && win?.webContents.executeJavaScript(script).catch(() => {});
  if (!win) {
    createWindow();
    win.webContents.once('did-finish-load', run);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', run);
  else run();
}
const command = (name, arg) => showWindow(`window.tutanakCommand?.(${JSON.stringify(name)}, ${JSON.stringify(arg ?? null)})`);

function broadcast(channel, payload) {
  for (const w of [win, promptWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

let changeTimer = null;
/** Arayüze "veriler değişti" der (kısa aralıklarla gelenleri birleştirir) */
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    broadcast('changed', { recording: recorder?.state() || null, jobs: jobs.status() });
    updateTray();
  }, 120);
}

// ------------------------------------------------------------ sağ üst bildirim

const PROMPT_WIDTH = 384;

function placePrompt(height = promptWin?.getBounds().height || 170) {
  if (!promptWin) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  promptWin.setBounds({ x: Math.round(wa.x + wa.width - PROMPT_WIDTH - 14), y: Math.round(wa.y + 10), width: PROMPT_WIDTH, height: Math.round(height) });
}

function showPrompt(data) {
  promptData = { ...data, shown_at: Date.now() };
  const send = () => {
    promptWin.webContents.send('prompt', promptData);
    placePrompt();
    promptWin.showInactive();
  };
  if (promptWin && !promptWin.isDestroyed()) {
    if (promptWin.webContents.isLoading()) promptWin.webContents.once('did-finish-load', send);
    else send();
    return;
  }
  promptWin = new BrowserWindow({
    width: PROMPT_WIDTH,
    height: 170,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: 'panel',            // tam ekran Teams toplantısının üstünde de görünür, odağı çalmaz
    acceptFirstMouse: true,
    hasShadow: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  promptWin.setAlwaysOnTop(true, 'screen-saver');
  promptWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  promptWin.on('closed', () => { promptWin = null; promptData = null; });
  promptWin.webContents.once('did-finish-load', send);
  promptWin.loadURL(`${ORIGIN}/prompt.html`);
}

function hidePrompt(kind) {
  if (!promptWin || (kind && promptData?.kind !== kind)) return;
  promptData = null;
  promptWin.hide();
}

async function onPromptAnswer({ action, mode } = {}) {
  const data = promptData;
  switch (action) {
    case 'record':
      if (!pendingCall && data?.kind !== 'ask') return hidePrompt();
      await startRecording({
        mode: MODES.includes(mode) ? mode : settings.get('mode'),
        title: data?.title || 'Toplantı',
        app: data?.app || '',
        app_key: data?.app_key || '',
        auto: false,
        refreshTitle: true,
      });
      break;
    case 'dismiss':
      if (pendingCall) pendingCall.dismissed = true;
      hidePrompt();
      break;
    case 'stop':
      recorder.stop();
      break;
    case 'cancel':
      recorder.stop({ discard: true });
      hidePrompt();
      break;
    case 'open':
      hidePrompt();
      command('open', data?.id || null);
      break;
    case 'permissions':
      hidePrompt();
      command('go', '#/ayarlar');
      break;
    case 'close':
    default:
      hidePrompt();
  }
}

// ------------------------------------------------------------ kayıt akışı

async function startRecording({ mode, title, app: appName = '', app_key = '', auto = false, refreshTitle = false }) {
  if (recorder.current) return recorder.state();
  // Toplantı penceresi bildirimden sonra açılmış olabilir: başlığı yeniden dene
  if (refreshTitle && app_key) {
    const fresh = await meetingTitle(app_key);
    if (fresh) title = fresh;
  }
  try {
    const st = await recorder.start({ mode, title, app: appName, app_key, auto });
    if (pendingCall && pendingCall.key === app_key) pendingCall.recording = true;
    showPrompt({ kind: 'recording', title: st.title, mode, mode_label: MODE_LABELS[mode], app: appName, auto });
    changed();
    return st;
  } catch (e) {
    const permission = e.kind === 'screen_permission';
    showPrompt({
      kind: 'error',
      title: permission ? 'Ekran kaydı izni gerekli' : 'Kayıt başlatılamadı',
      message: permission ? 'Sistem Ayarları → Gizlilik ve Güvenlik → Ekran ve Sistem Sesi Kaydı bölümünden Tutanak\'ı açın, sonra Tutanak\'ı yeniden başlatın.' : e.message,
      action: permission ? 'permissions' : null,
    });
    if (permission) helper.run(['request-screen']).catch(() => {});
    changed();
    throw e;
  }
}

async function onCallStart({ key, app: info }) {
  const s = settings.all();
  if (recorder.current || s.ask === 'never') return;
  const title = (await meetingTitle(key)) || `${info.short} görüşmesi`;
  pendingCall = { key, app: info.short, title, at: Date.now() };
  if (s.ask === 'always') {
    startRecording({ mode: s.mode, title, app: info.short, app_key: key, auto: true }).catch(() => {});
    return;
  }
  showPrompt({
    kind: 'ask', app: info.short, app_key: key, title, mode: s.mode,
    modes: MODES.map(m => ({ id: m, label: MODE_LABELS[m] })), timeout: s.prompt_timeout_sec,
  });
  updateTray();
}

function onCallEnd({ key }) {
  if (pendingCall?.key === key) {
    if (promptData?.kind === 'ask') hidePrompt();
    pendingCall = null;
  }
  const st = recorder.state();
  if (st && st.app_key === key && settings.get('auto_stop') && st.phase === 'recording') recorder.stop();
  updateTray();
}

function onRecordingFinished(meeting) {
  showPrompt({
    kind: 'finished', id: meeting.id, title: meeting.title, duration: formatTime(meeting.duration_sec),
    transcribing: settings.get('auto_transcribe'), warnings: meeting.warnings || [],
  });
  queueProcess(meeting.id);
  changed();
}

// ------------------------------------------------------------ arka plan işleri

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

function fallbackMedia(m) {
  const has = f => fs.existsSync(path.join(m.dir, f));
  if (m.mode === 'video' && has('ekran.mp4')) {
    fs.renameSync(path.join(m.dir, 'ekran.mp4'), path.join(m.dir, 'kayit.mp4'));
    return 'kayit.mp4';
  }
  return ['sistem.m4a', 'mikrofon.m4a'].find(has) || null;
}

async function runTranscribe(id, progress) {
  const s = settings.all();
  if (lib.meta(id).has_audio === false) throw new Error('Bu kayıtta ses yok');
  const ff = await ffmpeg.info(s.ffmpeg_path);
  if (!ff.ok) throw new Error('Döküm için ffmpeg gerekli (brew install ffmpeg)');
  lib.update(id, m => ({ transcript: { ...(m.transcript || {}), status: 'running', error: null } }));
  changed();
  try {
    const t = await transcribe(lib.meta(id), s, { ff, onProgress: p => progress('Döküm çıkarılıyor', p) });
    const m = lib.update(id, { transcript: t });
    notify('Döküm hazır', `${m.title} · ${t.words} kelime`, () => command('open', id));
    return t;
  } catch (e) {
    lib.update(id, { transcript: { status: 'failed', error: e.message } });
    throw e;
  } finally {
    changed();
  }
}

function queueProcess(id) {
  const job = jobs.add({
    id, kind: 'process', label: 'Kayıt işleniyor',
    run: async progress => {
      const s = settings.all();
      const ff = await ffmpeg.info(s.ffmpeg_path);
      let m = lib.meta(id);
      let media;
      try {
        if (ff.ok) {
          media = await mix(m, { ff, onProgress: p => progress('Ses izleri birleştiriliyor', p) });
        } else {
          media = fallbackMedia(m);
          lib.update(id, x => ({ warnings: [...new Set([...(x.warnings || []), 'ffmpeg bulunamadı: izler birleştirilmedi (brew install ffmpeg).'])] }));
        }
      } catch (e) {
        lib.update(id, { status: 'failed', error: e.message });
        changed();
        throw e;
      }
      const duration = media && ff.ok ? await ffmpeg.duration(ff.probe, path.join(m.dir, media)) : 0;
      // Video kipinde ses izi yoksa (mikrofon ve sistem sesi kapalı) dökülecek bir şey de yoktur
      const hasAudio = ['sistem.m4a', 'mikrofon.m4a'].some(f => fs.existsSync(path.join(m.dir, f))) || Boolean(media && m.mode !== 'video');
      m = lib.update(id, { media, has_audio: hasAudio, status: 'ready', error: null, duration_sec: Math.round(duration || m.duration_sec || 0) });
      changed();
      if (s.auto_transcribe && hasAudio && ff.ok) await runTranscribe(id, progress);
    },
  });
  job.then(changed, changed);
  return job;
}

function queueTranscribe(id) {
  return jobs.add({ id, kind: 'transcribe', label: 'Döküm', run: progress => runTranscribe(id, progress) });
}

function queueArchive(id) {
  return jobs.add({
    id, kind: 'archive', label: 'Arşivleniyor',
    run: async progress => {
      const s = settings.all();
      const ff = await ffmpeg.info(s.ffmpeg_path);
      try {
        const res = await archiveMeeting(lib, id, {
          ff, settings: s, onProgress: (step, pct) => { progress(step, pct); },
          transcribe: m => runTranscribe(m.id, progress),
        });
        return res;
      } finally {
        changed();
      }
    },
  });
}

function autoArchive() {
  const days = settings.get('auto_archive_days');
  if (!days) return;
  for (const m of dueForArchive(lib.list({ sizes: false }), days)) {
    if (!jobs.busy(m.id)) queueArchive(m.id);
  }
}

/** Uygulama kayıt sırasında kapanmış/çökmüşse yarım kalan işleri toparlar */
function recover() {
  for (const m of lib.list({ sizes: false })) {
    try {
      if (m.status === 'recording') {
        lib.update(m.id, x => ({ status: 'processing', ended_at: x.ended_at || x.updated_at || null, warnings: [...(x.warnings || []), 'Kayıt beklenmedik şekilde kesildi; kaydedilebilen kısım kurtarıldı.'] }));
        queueProcess(m.id);
      } else if (m.status === 'processing') {
        queueProcess(m.id);
      } else if (m.status === 'archiving') {
        for (const f of fs.readdirSync(m.dir)) if (f.startsWith('.arsiv.tmp')) fs.rmSync(path.join(m.dir, f), { force: true });
        lib.update(m.id, { status: 'ready' });
      }
      if (m.transcript?.status === 'running') lib.update(m.id, { transcript: { status: 'none' } });
    } catch (e) {
      console.error('Kurtarma:', m.id, e.message);
    }
  }
}

// ------------------------------------------------------------ menü çubuğu

let trayIcons = null;
let trayTimer = null;

function updateTray() {
  if (!tray) return;
  const st = recorder?.state();
  tray.setImage(st ? trayIcons.rec : trayIcons.idle);
  tray.setTitle(st && st.phase !== 'starting' ? ` ${formatTime(st.elapsed_sec)}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(st ? `Kaydediliyor: ${st.title}` : 'Tutanak');
  clearInterval(trayTimer);
  if (st) trayTimer = setInterval(() => {
    const s = recorder.state();
    if (s) tray.setTitle(` ${formatTime(s.elapsed_sec)}`, { fontType: 'monospacedDigit' });
  }, 1000);

  const startItems = MODES.map(mode => ({
    label: MODE_LABELS[mode] + (mode === settings.get('mode') ? '  (varsayılan)' : ''),
    click: () => startRecording({
      mode, title: pendingCall?.title || 'Toplantı', app: pendingCall?.app || '', app_key: pendingCall?.key || '',
    }).catch(() => {}),
  }));
  const recent = lib.list({ sizes: false }).slice(0, 6).map(m => ({
    label: `${new Date(m.started_at).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}  ${m.title.length > 40 ? `${m.title.slice(0, 39)}…` : m.title}`,
    click: () => command('open', m.id),
  }));
  const s = settings.all();
  const template = st ? [
    { label: `● Kaydediliyor — ${st.title}`, enabled: false },
    { label: `${MODE_LABELS[st.mode]} · ${formatTime(st.elapsed_sec)}`, enabled: false },
    { type: 'separator' },
    { label: 'Kaydı bitir', click: () => recorder.stop() },
    { label: 'Kaydı iptal et (sil)', click: () => recorder.stop({ discard: true }) },
  ] : [
    ...(pendingCall ? [{ label: `${pendingCall.app} görüşmesi sürüyor`, enabled: false }] : []),
    { label: 'Şimdi kaydet', submenu: startItems },
  ];
  template.push(
    { type: 'separator' },
    ...(recent.length ? [{ label: 'Son toplantılar', enabled: false }, ...recent, { type: 'separator' }] : []),
    {
      label: 'Toplantıları algıla',
      type: 'checkbox',
      checked: s.ask !== 'never',
      click: item => { settings.set({ ask: item.checked ? 'ask' : 'never' }); changed(); },
    },
    { label: 'Tutanak\'ı aç', click: () => command('go', '#/') },
    { label: 'Ayarlar…', click: () => command('go', '#/ayarlar') },
    { type: 'separator' },
    { label: 'Çık', role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const idle = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  idle.setTemplateImage(true);
  const rec = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayRecording.png'));
  trayIcons = { idle, rec };
  tray = new Tray(idle);
  updateTray();
}

// ------------------------------------------------------------ IPC

function meetingBrief(m) {
  return {
    id: m.id, title: m.title, app: m.app, mode: m.mode, status: m.status, started_at: m.started_at,
    duration_sec: m.duration_sec, size_bytes: m.size_bytes, shot_count: m.shot_count,
    transcript: m.transcript?.status || 'none', has_notes: m.has_notes, has_summary: m.has_summary,
    action_items: (m.action_items || []).length, tags: m.tags || [], archive: m.archive || null,
    warnings: (m.warnings || []).length, in_archive_dir: m.in_archive_dir, busy: jobs.busy(m.id),
  };
}

function meetingDetail(id) {
  const m = lib.meta(id);
  const v = encodeURIComponent(m.updated_at || m.started_at || '');
  const url = rel => `${ORIGIN}/media/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}?v=${v}`;
  const t = lib.transcript(id);
  return {
    ...m,
    mode_label: MODE_LABELS[m.mode] || m.mode,
    notes: lib.text(id, NOTES),
    summary: lib.text(id, SUMMARY),
    media_url: m.media && fs.existsSync(path.join(m.dir, m.media)) ? url(m.media) : null,
    shots: lib.shots(id).map(s => ({ ...s, url: url(s.file) })),
    segments: t?.segments || [],
    transcript_info: t ? { engine: t.engine, locale: t.locale, split: t.split_speakers, created_at: t.created_at } : null,
    files: lib.files(id),
    size_bytes: dirSize(m.dir),
    busy: jobs.busy(id),
  };
}

async function confirmDelete(ids) {
  const items = ids.map(id => { try { return lib.meta(id); } catch { return null; } }).filter(Boolean);
  if (!items.length) return { ok: false };
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Çöp Sepetine taşı', 'Vazgeç'],
    defaultId: 1,
    cancelId: 1,
    message: items.length === 1 ? `"${items[0].title}" silinsin mi?` : `${items.length} toplantı silinsin mi?`,
    detail: 'Kayıt, döküm ve notlar Çöp Sepeti\'ne taşınır; oradan geri alınabilir.',
  });
  if (response !== 0) return { ok: false };
  for (const m of items) {
    if (recorder.state()?.id === m.id || jobs.busy(m.id)) continue;
    await shell.trashItem(m.dir);
  }
  changed();
  return { ok: true };
}

async function testRecording() {
  if (recorder.current) throw new Error('Kayıt sürerken test yapılamaz');
  const s = settings.all();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutanak-test-'));
  return new Promise(resolve => {
    const peaks = { mic: 0, system: 0 };
    const warnings = [];
    let error = null;
    let started = false;
    const child = helper.start(['record', '--dir', dir, '--mode', 'audio', '--mic', s.mic || 'default', '--system', s.system_audio ? '1' : '0'], {
      onEvent: msg => {
        if (msg.event === 'started') {
          started = true;
          setTimeout(() => child.stdin.write('stop\n'), 6000);
        } else if (msg.event === 'level') {
          peaks.mic = Math.max(peaks.mic, msg.mic || 0);
          peaks.system = Math.max(peaks.system, msg.system || 0);
          broadcast('test-level', { ...msg, peaks });
        } else if (msg.event === 'warn') warnings.push(msg.message);
        else if (msg.event === 'error') error = msg;
      },
      onExit: () => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve({ ok: started && !error, peaks, warnings, error: error?.error || null, kind: error?.kind || null });
      },
    });
  });
}

const PRIVACY_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  audio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

const handlers = {
  'app:state': async () => {
    const s = settings.all();
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      settings: s,
      recording: recorder.state(),
      jobs: jobs.status(),
      call: pendingCall ? { app: pendingCall.app, title: pendingCall.title, key: pendingCall.key } : null,
      helper: Boolean(helperPath()),
      ffmpeg: await ffmpeg.info(s.ffmpeg_path),
      modes: MODES.map(id => ({ id, label: MODE_LABELS[id] })),
      apps: Object.entries(APPS).map(([id, a]) => ({ id, name: a.name, short: a.short })),
      profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label })),
      open_at_login: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
    };
  },
  'meetings:list': ({ query = '' } = {}) => {
    const words = String(query).toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
    return lib.list()
      .filter(m => !words.length || words.every(w => lib.searchText(m.id).includes(w)))
      .map(meetingBrief);
  },
  'meeting:get': id => meetingDetail(id),
  'meeting:update': (id, patch = {}) => {
    const p = {};
    if (typeof patch.title === 'string' && patch.title.trim()) p.title = patch.title.trim().slice(0, 200);
    if (Array.isArray(patch.tags)) p.tags = patch.tags.map(String).filter(Boolean);
    if (Array.isArray(patch.action_items)) {
      p.action_items = patch.action_items.filter(a => a && String(a.text || '').trim())
        .map(a => ({ ...a, text: String(a.text).trim(), done: Boolean(a.done) }));
    }
    lib.update(id, p);
    changed();
    return meetingDetail(id);
  },
  'meeting:text': (id, name, text) => { lib.setText(id, name === 'summary' ? SUMMARY : NOTES, text); return true; },
  'meeting:delete': ids => confirmDelete([].concat(ids)),
  'meeting:reveal': id => shell.openPath(lib.dirOf(id)),
  'meeting:transcribe': id => { queueTranscribe(id); changed(); return true; },
  'meeting:reprocess': id => { queueProcess(id); changed(); return true; },
  'meeting:archive': ids => {
    for (const id of [].concat(ids)) queueArchive(id);
    changed();
    return true;
  },
  'meeting:claude-prompt': id => {
    const m = lib.meta(id);
    const when = new Date(m.started_at).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    const text = `Tutanak'taki "${m.title}" (${when}) toplantısını özetle: kararlar, açık sorular ve eylem maddeleri; sonra özeti toplantıya kaydet.`;
    clipboard.writeText(text);
    return text;
  },
  'record:start': ({ mode } = {}) => startRecording({
    mode: MODES.includes(mode) ? mode : settings.get('mode'),
    title: pendingCall?.title || 'Toplantı',
    app: pendingCall?.app || '',
    app_key: pendingCall?.key || '',
  }).then(() => recorder.state()),
  'record:stop': () => recorder.stop(),
  'record:cancel': () => recorder.stop({ discard: true }),
  'settings:set': patch => {
    const before = settings.all();
    const next = settings.set(patch);
    if ('open_at_login' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(patch.open_at_login) });
    if (before.ask !== next.ask || String(before.apps) !== String(next.apps)) detector.evaluate();
    changed();
    return next;
  },
  'settings:choose-dir': async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return canceled ? null : filePaths[0];
  },
  'permissions:get': () => helper.run(['permissions'], { timeoutMs: 5000 }).catch(e => ({ error: e.message })),
  'permissions:request': async kind => {
    const cmd = { screen: 'request-screen', audio: 'request-audio', mic: 'request-mic' }[kind];
    if (!cmd) return null;
    const res = await helper.run([cmd], { timeoutMs: 120000 }).catch(e => ({ error: e.message }));
    return res;
  },
  'permissions:open': kind => shell.openExternal(PRIVACY_PANES[kind] || PRIVACY_PANES.screen),
  // İzin kayıtları uygulamanın imzasına bağlıdır. Uygulama başka bir imzayla yeniden kurulunca
  // Sistem Ayarları'nda açık görünen eski kayıt bu sürüme uygulanmaz; silinip yeniden istenmesi gerekir.
  'permissions:reset': async () => {
    const id = ownBundleId();
    if (!app.isPackaged || !id) throw new Error('İzinler yalnızca /Applications\'a kurulu uygulamada sıfırlanabilir');
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Sıfırla', 'Vazgeç'],
      defaultId: 0,
      cancelId: 1,
      message: 'Tutanak\'ın izinleri sıfırlansın mı?',
      detail: 'Ekran kaydı, sistem sesi ve mikrofon izinlerinin eski kayıtları silinir. Ardından her biri için "İzin ver"e basıp macOS\'un sorusunu onaylayın; ekran kaydından sonra Tutanak\'ı yeniden açın.',
    });
    if (response !== 0) return false;
    for (const service of ['ScreenCapture', 'AudioCapture', 'Microphone']) {
      await new Promise(resolve => execFile('/usr/bin/tccutil', ['reset', service, id], () => resolve()));
    }
    return true;
  },
  'devices': () => helper.run(['devices'], { timeoutMs: 5000 }).catch(e => ({ error: e.message, mics: [], displays: [] })),
  'test:record': () => testRecording(),
  // Ajanda kuruluysa toplantıyı ona bölmesi için gönderir (ajanda://parcala?toplanti=…); yoksa düğme görünmez
  'ajanda:available': () => Boolean(app.getApplicationNameForProtocol('ajanda://parcala')),
  'ajanda:split': id => {
    lib.meta(id); // toplantı var mı
    return shell.openExternal(`ajanda://parcala?toplanti=${encodeURIComponent(id)}`);
  },
  'claude:status': () => claude.status(),
  'claude:connect': () => {
    if (!app.isPackaged) throw new Error('Claude bağlantısı yalnızca /Applications\'a kurulu uygulamadan yapılabilir');
    return claude.connect();
  },
  'clipboard:write': text => { clipboard.writeText(String(text ?? '')); return true; },
  'path:reveal': p => { if (typeof p === 'string' && path.isAbsolute(p)) shell.openPath(p); },
  'prompt:answer': answer => onPromptAnswer(answer),
  'prompt:resize': height => { if (promptWin && Number(height) > 40) placePrompt(Math.min(420, Number(height))); },
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message, kind: e.kind };
    }
  });
}

// ------------------------------------------------------------ uygulama menüsü

function buildMenu() {
  const go = hash => () => command('go', hash);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', label: 'Tutanak' },
    {
      label: 'Dosya',
      submenu: [
        { label: 'Şimdi kaydet', accelerator: 'CmdOrCtrl+Shift+R', click: () => startRecording({ mode: settings.get('mode'), title: pendingCall?.title || 'Toplantı', app: pendingCall?.app || '', app_key: pendingCall?.key || '' }).catch(() => {}) },
        { label: 'Kaydı bitir', accelerator: 'CmdOrCtrl+Shift+S', click: () => recorder.stop() },
        { type: 'separator' },
        { label: 'Kayıt klasörünü göster', click: () => { fs.mkdirSync(settings.libraryDir(), { recursive: true }); shell.openPath(settings.libraryDir()); } },
        { type: 'separator' },
        { role: 'close', label: 'Pencereyi kapat' },
      ],
    },
    { role: 'editMenu', label: 'Düzen' },
    {
      label: 'Git',
      submenu: [
        { label: 'Toplantılar', accelerator: 'CmdOrCtrl+1', click: go('#/') },
        { label: 'Ara', accelerator: 'CmdOrCtrl+F', click: () => command('search') },
        { label: 'Ayarlar', accelerator: 'CmdOrCtrl+,', click: go('#/ayarlar') },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { role: 'reload', label: 'Yenile' },
        { role: 'toggleDevTools', label: 'Geliştirici araçları' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Gerçek boyut' },
        { role: 'zoomIn', label: 'Yakınlaştır' },
        { role: 'zoomOut', label: 'Uzaklaştır' },
      ],
    },
    { role: 'windowMenu', label: 'Pencere' },
  ]));
}

// ------------------------------------------------------------ başlangıç

let quietLaunchUntil = 0; // Mac açılışında başlatıldıysa ilk "activate" pencere açmasın
app.on('second-instance', () => showWindow());
app.on('activate', () => { if (Date.now() > quietLaunchUntil) showWindow(); });

app.whenReady().then(() => {
  protocol.handle('app', handleRequest);
  recorder = new Recorder({ lib, settings, excludeBundles: [ownBundleId()].filter(Boolean) });
  recorder.on('change', changed);
  recorder.on('level', lvl => broadcast('level', lvl));
  recorder.on('shot', shot => broadcast('shot', shot));
  recorder.on('finished', onRecordingFinished);
  recorder.on('discarded', () => { hidePrompt(); changed(); });
  jobs.on('change', status => broadcast('jobs', status));
  jobs.on('done', changed);
  jobs.on('failed', ({ id, kind, error }) => {
    if (kind !== 'transcribe' && kind !== 'process') {
      notify(kind === 'archive' ? 'Arşivlenemedi' : 'İşlem başarısız', error, () => command('open', id));
    }
  });

  detector = new Detector(() => settings.all());
  detector.on('start', e => onCallStart(e).catch(err => console.error('Görüşme başlangıcı:', err)));
  detector.on('end', onCallEnd);

  if (app.isPackaged && settings.get('open_at_login') == null) {
    app.setLoginItemSettings({ openAtLogin: true });
    settings.set({ open_at_login: true });
  }
  buildMenu();
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png'));
  createTray();
  recover();
  detector.start();

  // Mac açılışında otomatik başlatıldıysa yalnızca menü çubuğunda dursun
  const atLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!atLogin || !settings.get('onboarded')) createWindow();
  else {
    quietLaunchUntil = Date.now() + 5000;
    app.dock?.hide();
  }

  setTimeout(autoArchive, 60 * 1000);
  setInterval(autoArchive, AUTO_ARCHIVE_MS);

  if (process.env.TUTANAK_AUTOMATION) {
    // Geliştirme otomasyonu (ekran görüntüsü/smoke testleri); gerçek ayarlara dokunmamak için TUTANAK_DATA_DIR ile kullanın
    const run = require(path.resolve(process.env.TUTANAK_AUTOMATION));
    const ctx = { app, get win() { return win; }, get promptWin() { return promptWin; }, lib, settings, get recorder() { return recorder; }, detector, jobs, showPrompt, hidePrompt, onCallStart, onCallEnd, startRecording, queueProcess, queueArchive, command, APPS };
    setTimeout(() => Promise.resolve(run(ctx)).catch(e => { console.error('Otomasyon:', e); app.exit(1); }), 1500);
  }
});

app.on('before-quit', e => {
  if (recorder?.current && !quitting) {
    // Kayıt sürüyorsa önce düzgünce kapatılsın; işlenmesi bir sonraki açılışta tamamlanır
    e.preventDefault();
    quitting = true;
    const done = () => setImmediate(() => app.quit());
    recorder.once('finished', done);
    recorder.once('discarded', done);
    recorder.stop();
    setTimeout(() => app.exit(0), 20000);
    return;
  }
  quitting = true;
  detector?.stop();
});

app.on('window-all-closed', () => {
  // Menü çubuğunda çalışmaya devam eder
});
