'use strict';
/* Tutanak arayüzü: toplantı listesi, oynatıcı + döküm/kareler/notlar/özet, ayarlar. */

const api = window.tutanak;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON_PATHS = {
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  audio: '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  shots: '<rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 15l-5-5-8 8"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/>',
  record: '<circle cx="12" cy="12" r="7"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16m0 4v-4h-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5"/>',
};
const icon = name => `<svg class="i" viewBox="0 0 24 24">${ICON_PATHS[name] || ''}</svg>`;
const MODE_ICON = { video: 'video', audio: 'audio', shots: 'shots' };
const MODE_SHORT = { video: 'Video', audio: 'Ses', shots: 'Ses + kare' };
const MODE_HINT = {
  video: 'Ekranın videosu, karşı tarafın sesi ve mikrofonunuz. En çok yer kaplar.',
  audio: 'Karşı tarafın sesi ve mikrofonunuz. En az yer kaplar.',
  shots: 'Ses kaydı ve belirli aralıklarla ekran görüntüsü; sunumları da yakalar.',
};

const state = {
  app: null,
  meetings: [],
  filter: 'all',
  query: '',
  selected: new Set(),
  detail: null,
  tab: 'transcript',
  trFilter: '',
  follow: true,
  editingSummary: false,
};

// ------------------------------------------------------------ biçimler

function fmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDuration(sec) {
  const s = Math.round(sec || 0);
  if (s < 60) return `${s} sn`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa ${m % 60 ? `${m % 60} dk` : ''}`.trim();
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

const hm = iso => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

function dayHead(iso) {
  const d = new Date(iso);
  const today = new Date();
  const key = x => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (key(d) === key(today)) return 'Bugün';
  if (key(d) === key(y)) return 'Dün';
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

const STATUS = {
  recording: ['Kaydediliyor', 'rec'], processing: ['İşleniyor', 'accent'], archiving: ['Arşivleniyor', 'accent'],
  archived: ['Arşiv', ''], failed: ['Hata', 'warn'],
};

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

async function call(channel, ...args) {
  try {
    return await api.call(channel, ...args);
  } catch (e) {
    toast(e.message);
    throw e;
  }
}

/** Basit ve güvenli Markdown (başlık, liste, kalın, eğik, kod) */
function markdown(src) {
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^\s*[-*•]\s+(?:\[( |x)\]\s+)?(.*)$/i.exec(line))) {
      if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${m[1] ? (m[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') : ''}${inline(m[2])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

// ------------------------------------------------------------ veri

async function loadApp() {
  state.app = await call('app:state');
}

async function loadMeetings() {
  state.meetings = await call('meetings:list', { query: state.query });
  for (const id of [...state.selected]) if (!state.meetings.some(m => m.id === id)) state.selected.delete(id);
}

function visibleMeetings() {
  return state.meetings.filter(m => state.filter === 'all'
    || (state.filter === 'archived' ? m.status === 'archived' : m.status !== 'archived'));
}

// ------------------------------------------------------------ kenar çubuğu

function renderRec() {
  const el = $('#rec');
  const r = state.app?.recording;
  const s = state.app?.settings || {};
  if (r) {
    el.innerHTML = `
      <div class="rec-card live">
        <div class="rec-head"><span class="rec-dot"></span><span class="title" title="${esc(r.title)}">${esc(r.title)}</span></div>
        <div class="rec-time num" id="rec-time">${r.phase === 'starting' ? 'Başlıyor…' : r.phase === 'stopping' ? 'Kapatılıyor…' : fmtClock(r.elapsed_sec)}</div>
        <div class="rec-sub">${esc(MODE_SHORT[r.mode])}${r.app ? ` · ${esc(r.app)}` : ''}${r.mode === 'shots' ? ` · <span id="rec-shots">${r.shots}</span> kare` : ''}</div>
        <div class="rec-levels">
          <span>Mikrofon</span><div class="meter levels"><span id="lvl-mic"></span></div>
          <span>Karşı taraf</span><div class="meter levels"><span id="lvl-system"></span></div>
        </div>
        <div class="rec-actions">
          <button class="btn rec sm" data-act="stop" ${r.phase !== 'recording' ? 'disabled' : ''}>${icon('stop')} Bitir</button>
          <button class="btn sm" data-act="cancel" ${r.phase !== 'recording' ? 'disabled' : ''}>İptal</button>
        </div>
      </div>`;
    el.querySelector('[data-act="stop"]').onclick = () => call('record:stop');
    el.querySelector('[data-act="cancel"]').onclick = () => {
      if (confirm('Kayıt silinsin mi? Bu kayıttan hiçbir şey saklanmaz.')) call('record:cancel');
    };
    return;
  }
  const call_ = state.app?.call;
  const watching = s.ask === 'never' ? 'Algılama kapalı'
    : `${(s.apps || []).map(id => state.app.apps.find(a => a.id === id)?.short).filter(Boolean).join(', ') || 'Hiçbir uygulama'} izleniyor`;
  el.innerHTML = `
    <div class="rec-card">
      <div class="call-line"><span class="dot ${call_ ? 'on' : ''}"></span>${call_ ? `${esc(call_.app)} görüşmesi sürüyor` : esc(watching)}</div>
      <div class="start-row">
        <select id="start-mode" title="Kayıt biçimi">${state.app.modes.map(m => `<option value="${m.id}" ${m.id === s.mode ? 'selected' : ''}>${esc(MODE_SHORT[m.id])}</option>`).join('')}</select>
        <button class="btn rec sm" id="start-btn">${icon('record')} Kaydet</button>
      </div>
    </div>`;
  $('#start-btn').onclick = async () => {
    $('#start-btn').disabled = true;
    try { await call('record:start', { mode: $('#start-mode').value }); } catch {}
    refresh();
  };
}

function renderJob(status = state.app?.jobs) {
  const el = $('#job');
  const j = status?.current;
  if (!j) { el.innerHTML = ''; return; }
  const m = state.meetings.find(x => x.id === j.id);
  const queued = status.queued.length;
  el.innerHTML = `
    <div class="job-card">
      <div class="row"><b>${esc(j.step || j.label)}</b><span class="num muted">${Math.round((j.pct || 0) * 100)}%</span></div>
      <div class="meter"><span style="width:${Math.round((j.pct || 0) * 100)}%"></span></div>
      <div class="muted" style="margin-top:5px">${esc(m?.title || '')}${queued ? ` · sırada ${queued} iş` : ''}</div>
    </div>`;
}

function rowHtml(m, active) {
  const st = STATUS[m.status];
  const badges = [];
  if (m.busy || m.status === 'processing' || m.status === 'archiving') badges.push(`<span class="badge accent">${icon('refresh')}</span>`);
  else if (st) badges.push(`<span class="badge ${st[1]}">${st[0]}</span>`);
  if (m.warnings && m.status !== 'archived') badges.push(`<span class="badge warn" title="Uyarı var">${icon('warn')}</span>`);
  return `
    <div class="mrow ${active ? 'active' : ''}" data-id="${esc(m.id)}">
      <input type="checkbox" class="check sel" ${state.selected.has(m.id) ? 'checked' : ''} title="Seç">
      <div class="mrow-main">
        <div class="mrow-title">${esc(m.title)}</div>
        <div class="mrow-meta">${icon(MODE_ICON[m.mode] || 'audio')}<span>${hm(m.started_at)}</span>·<span>${fmtDuration(m.duration_sec)}</span>·<span>${fmtBytes(m.size_bytes)}</span>${m.transcript === 'done' ? `·${icon('text')}` : ''}</div>
      </div>
      <div class="mrow-badges">${badges.join('')}</div>
    </div>`;
}

function renderList() {
  const el = $('#list');
  const items = visibleMeetings();
  const activeId = state.detail?.id;
  if (!items.length) {
    el.innerHTML = `<div class="list-empty">${state.query ? 'Eşleşen toplantı yok' : state.filter === 'archived' ? 'Arşivde toplantı yok' : 'Henüz kayıt yok'}</div>`;
  } else {
    let last = '';
    el.innerHTML = items.map(m => {
      const head = dayHead(m.started_at);
      const out = (head !== last ? `<div class="day-head">${esc(head)}</div>` : '') + rowHtml(m, m.id === activeId);
      last = head;
      return out;
    }).join('');
  }
  el.classList.toggle('selecting', state.selected.size > 0);
  renderFoot();
}

function renderFoot() {
  const el = $('#foot');
  if (state.selected.size) {
    el.innerHTML = `
      <div class="bulk">
        <span class="count">${state.selected.size} seçili</span>
        <button class="btn sm primary" id="bulk-archive">${icon('archive')} Arşivle</button>
        <button class="btn sm danger" id="bulk-delete">${icon('trash')}</button>
        <button class="icon-btn" id="bulk-clear" title="Seçimi kaldır">${icon('x')}</button>
      </div>`;
    $('#bulk-archive').onclick = async () => {
      const ids = [...state.selected].filter(id => state.meetings.find(m => m.id === id)?.status === 'ready');
      if (!ids.length) return toast('Seçilenler arasında arşivlenecek hazır toplantı yok');
      await call('meeting:archive', ids);
      state.selected.clear();
      toast(`${ids.length} toplantı arşivleme sırasına alındı`);
      refresh();
    };
    $('#bulk-delete').onclick = async () => {
      const res = await call('meeting:delete', [...state.selected]);
      if (res.ok) { state.selected.clear(); refresh(); }
    };
    $('#bulk-clear').onclick = () => { state.selected.clear(); renderList(); };
    return;
  }
  const total = state.meetings.reduce((n, m) => n + (m.size_bytes || 0), 0);
  const ready = state.meetings.filter(m => m.status === 'ready');
  const readySize = ready.reduce((n, m) => n + (m.size_bytes || 0), 0);
  el.innerHTML = `
    <div class="storage"><span>${state.meetings.length} toplantı · ${fmtBytes(total)}</span></div>
    ${ready.length ? `<button class="btn sm block" id="archive-all" title="Hazır durumdaki tüm toplantıları sıkıştırır">${icon('archive')} Tümünü arşivle (${ready.length} · ${fmtBytes(readySize)})</button>` : ''}`;
  const all = $('#archive-all');
  if (all) all.onclick = async () => {
    if (!confirm(`${ready.length} toplantı sıkıştırılıp arşivlenecek. Ham ses izleri silinir (döküm yoksa önce döküm çıkarılır). Devam edilsin mi?`)) return;
    await call('meeting:archive', ready.map(m => m.id));
    toast('Arşivleme başladı');
    refresh();
  };
}

$('#list').addEventListener('click', e => {
  const row = e.target.closest('.mrow');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.classList.contains('sel')) {
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    renderList();
    return;
  }
  if (e.metaKey || e.shiftKey) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    renderList();
    return;
  }
  location.hash = `#/m/${encodeURIComponent(id)}`;
});

let searchTimer;
$('#q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.query = e.target.value.trim();
    await loadMeetings();
    renderList();
  }, 220);
});

$('#filter').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.filter = b.dataset.f;
  $$('#filter button').forEach(x => x.classList.toggle('on', x === b));
  renderList();
});

// ------------------------------------------------------------ toplantı ayrıntısı

function player(d) {
  if (!d.media_url && !d.shots.length) {
    return `<div class="notice info"><div class="body">${d.status === 'processing' ? 'Kayıt işleniyor…' : 'Oynatılacak kayıt yok.'}</div></div>`;
  }
  if (d.mode === 'video' && d.media_url) {
    return `<div class="player"><video id="media" src="${esc(d.media_url)}" controls preload="metadata"></video></div>`;
  }
  const first = d.shots[0];
  const stage = d.shots.length ? `
    <div class="stage"><img id="stage-img" src="${esc(first.url)}" alt=""><span class="stamp num" id="stage-stamp">${fmtClock(first.t)}</span></div>` : '';
  const audio = d.media_url ? `<audio id="media" src="${esc(d.media_url)}" controls preload="metadata"></audio>` : '';
  return `<div class="player ${d.shots.length ? '' : 'audio-only'}">${stage}${audio}</div>`;
}

function headHtml(d) {
  const st = STATUS[d.status];
  const when = new Date(d.started_at).toLocaleString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const busy = d.busy || ['processing', 'archiving', 'recording'].includes(d.status);
  const saved = d.archive ? ` <span class="badge good" title="Arşivlemeden önce ${fmtBytes(d.archive.before_bytes)}">−${Math.max(0, Math.round(100 - (d.archive.after_bytes / Math.max(1, d.archive.before_bytes)) * 100))}%</span>` : '';
  return `
    <input class="title-input" id="title" value="${esc(d.title)}" spellcheck="false">
    <div class="d-meta">
      <span>${esc(when)}</span><span class="sep">|</span>
      <span>${fmtDuration(d.duration_sec)}</span><span class="sep">|</span>
      ${d.app ? `<span>${esc(d.app)}</span><span class="sep">|</span>` : ''}
      <span class="badge">${icon(MODE_ICON[d.mode])} ${esc(d.mode_label)}</span>
      <span class="num">${fmtBytes(d.size_bytes)}</span>${saved}
      ${st ? `<span class="badge ${st[1]}">${st[0]}</span>` : ''}
    </div>
    <div class="toolbar">
      <button class="btn sm primary" id="b-archive" ${busy || d.status !== 'ready' ? 'disabled' : ''} title="Videoyu/sesi sıkıştırır, ham izleri siler">${icon('archive')} ${d.status === 'archived' ? 'Arşivlendi' : 'Arşivle'}</button>
      <button class="btn sm" id="b-transcribe" ${busy || d.has_audio === false || (!d.media_url && !d.files['mikrofon.m4a'] && !d.files['sistem.m4a']) ? 'disabled' : ''}>${icon('text')} ${d.segments.length ? 'Dökümü yenile' : 'Döküm çıkar'}</button>
      <button class="btn sm" id="b-claude" title="Claude için hazır bir istek panoya kopyalanır">${icon('spark')} Claude'a sor</button>
      ${d.status === 'failed' ? `<button class="btn sm" id="b-reprocess">${icon('refresh')} Yeniden işle</button>` : ''}
      <span class="spacer"></span>
      <button class="btn sm ghost" id="b-folder">${icon('folder')} Klasör</button>
      <button class="btn sm ghost danger" id="b-delete" ${busy ? 'disabled' : ''}>${icon('trash')} Sil</button>
    </div>`;
}

function noticesHtml(d) {
  const out = [];
  const job = state.app?.jobs;
  const running = job?.current?.id === d.id ? job.current : null;
  if (running) {
    out.push(`<div class="notice info"><div class="body"><b>${esc(running.step)}</b> · ${Math.round(running.pct * 100)}%<div class="meter" style="margin-top:6px"><span style="width:${Math.round(running.pct * 100)}%"></span></div></div></div>`);
  } else if (job?.queued.some(j => j.id === d.id)) {
    out.push('<div class="notice info"><div class="body">Sırada bekliyor…</div></div>');
  }
  if (d.status === 'failed' && d.error) out.push(`<div class="notice warn">${icon('warn')}<div class="body">${esc(d.error)}</div></div>`);
  if (d.archive_error) out.push(`<div class="notice warn">${icon('warn')}<div class="body">Arşivlenemedi: ${esc(d.archive_error)}</div></div>`);
  if (d.transcript?.status === 'failed') out.push(`<div class="notice warn">${icon('warn')}<div class="body">Döküm çıkarılamadı: ${esc(d.transcript.error || '')}</div></div>`);
  if (d.warnings?.length && d.status !== 'archived') {
    out.push(`<div class="notice warn">${icon('warn')}<div class="body"><ul>${d.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div></div>`);
  }
  return out.join('');
}

function tabsHtml(d) {
  const tabs = [
    ['transcript', 'Döküm', d.segments.length || ''],
    ...(d.shots.length ? [['shots', 'Kareler', d.shots.length]] : []),
    ['notes', 'Notlar', ''],
    ['summary', 'Özet ve eylemler', d.action_items?.length || ''],
  ];
  if (!tabs.some(t => t[0] === state.tab)) state.tab = 'transcript';
  return tabs.map(([id, label, n]) => `<button data-tab="${id}" class="${state.tab === id ? 'on' : ''}">${label}${n ? `<span class="count">${n}</span>` : ''}</button>`).join('');
}

function highlight(text, q) {
  if (!q) return esc(text);
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return esc(text).replace(re, m => `<mark>${m}</mark>`);
}

function transcriptHtml(d) {
  if (!d.segments.length) {
    const t = d.transcript?.status;
    const msg = d.has_audio === false ? 'Bu kayıtta ses yok (mikrofon ve sistem sesi kapalıydı).' : t === 'running' ? 'Döküm çıkarılıyor…' : d.status === 'processing' ? 'Kayıt işlendikten sonra döküm çıkarılacak.' : 'Bu toplantının dökümü yok. Üstteki "Döküm çıkar" düğmesini kullanın.';
    return `<div class="empty-md">${msg}</div>`;
  }
  const q = state.trFilter.toLocaleLowerCase('tr');
  const segs = q ? d.segments.filter(s => s.text.toLocaleLowerCase('tr').includes(q)) : d.segments;
  const me = state.app.settings.me_label;
  const info = d.transcript_info;
  return `
    <div class="tr-tools">
      <input type="search" id="tr-q" placeholder="Dökümde ara…" value="${esc(state.trFilter)}">
      <label class="check small"><input type="checkbox" id="tr-follow" ${state.follow ? 'checked' : ''}> Oynatmayı takip et</label>
      <span class="spacer" style="flex:1"></span>
      <span class="muted small">${d.transcript?.words || 0} kelime${info?.split ? '' : ' · konuşmacılar ayrılmadı'}</span>
      <button class="btn sm ghost" id="tr-copy">${icon('copy')} Kopyala</button>
    </div>
    <div class="segments ${info?.split || d.segments.some(s => s.speaker) ? '' : 'no-speakers'}">
      ${segs.map(s => `
        <div class="seg" data-start="${s.start}" data-end="${s.end}">
          <button class="time">${fmtClock(s.start)}</button>
          <span class="spk ${s.speaker === me ? 'me' : 'others'}">${esc(s.speaker || '')}</span>
          <p>${highlight(s.text, state.trFilter)}</p>
        </div>`).join('') || '<div class="empty-md">Eşleşme yok</div>'}
    </div>`;
}

function shotsHtml(d) {
  return `<div class="shots">${d.shots.map(s => `
    <button class="shot" data-t="${s.t}"><img loading="lazy" src="${esc(s.url)}" alt=""><span>${fmtClock(s.t)}</span></button>`).join('')}</div>`;
}

function notesHtml(d) {
  return `
    <div class="editor-head"><span class="muted small">Toplantı sırasında ya da sonrasında kendi notlarınız (Markdown). Claude bunları da okur.</span><span class="saved" id="notes-saved"></span></div>
    <textarea class="notes-area" id="notes" placeholder="Notlarınızı buraya yazın…">${esc(d.notes)}</textarea>`;
}

function summaryHtml(d) {
  const editing = state.editingSummary || !d.summary.trim();
  const items = d.action_items || [];
  return `
    <div class="card">
      <div class="card-head">
        <div><h2>Özet</h2><p class="muted small">Claude'a "Tutanak'taki bu toplantıyı özetle" dediğinizde özet buraya yazılır; kendiniz de düzenleyebilirsiniz.</p></div>
        ${d.summary.trim() ? `<button class="btn sm" id="sum-toggle">${editing ? 'Önizle' : `${icon('edit')} Düzenle`}</button>` : ''}
      </div>
      ${editing
        ? `<textarea class="notes-area" id="summary" placeholder="Henüz özet yok.">${esc(d.summary)}</textarea><div class="saved" id="summary-saved"></div>`
        : `<div class="md">${markdown(d.summary)}</div>`}
    </div>
    <div class="card">
      <div class="card-head"><h2>Eylem maddeleri</h2><button class="btn sm" id="ai-add">${icon('plus')} Ekle</button></div>
      <div class="actions-list" id="ai-list">
        ${items.length ? items.map((a, i) => `
          <div class="action-row ${a.done ? 'done' : ''}" data-i="${i}">
            <input type="checkbox" class="check" data-k="done" ${a.done ? 'checked' : ''}>
            <input type="text" class="text" data-k="text" value="${esc(a.text)}" placeholder="Ne yapılacak">
            <input type="text" data-k="owner" value="${esc(a.owner || '')}" placeholder="Sorumlu">
            <input type="text" data-k="due" value="${esc(a.due || '')}" placeholder="Tarih">
            <button class="icon-btn" data-del="${i}" title="Kaldır">${icon('x')}</button>
          </div>`).join('') : '<div class="empty-md">Henüz eylem maddesi yok.</div>'}
      </div>
    </div>`;
}

function renderTab(d) {
  const body = $('#tab-body');
  if (!body) return;
  if (state.tab === 'transcript') body.innerHTML = transcriptHtml(d);
  else if (state.tab === 'shots') body.innerHTML = shotsHtml(d);
  else if (state.tab === 'notes') body.innerHTML = notesHtml(d);
  else body.innerHTML = summaryHtml(d);
  bindTab(d);
  syncToMedia();
}

function seek(t) {
  const media = $('#media');
  if (media) {
    media.currentTime = Math.max(0, t - 0.3);
    media.play().catch(() => {});
  } else {
    showShotAt(t);
  }
}

function showShotAt(t) {
  const d = state.detail;
  if (!d?.shots.length) return;
  let cur = d.shots[0];
  for (const s of d.shots) { if (s.t <= t + 0.5) cur = s; else break; }
  const img = $('#stage-img');
  if (img && !img.src.endsWith(cur.url)) img.src = cur.url;
  const stamp = $('#stage-stamp');
  if (stamp) stamp.textContent = fmtClock(cur.t);
  $$('.shot').forEach(b => b.classList.toggle('now', Number(b.dataset.t) === cur.t));
}

function syncToMedia() {
  const media = $('#media');
  const t = media ? media.currentTime : 0;
  if (state.detail?.shots.length) showShotAt(t);
  const segs = $$('.seg');
  let now = null;
  for (const el of segs) {
    const on = t >= Number(el.dataset.start) && t < Number(el.dataset.end) + 0.8;
    el.classList.toggle('now', on);
    if (on && !now) now = el;
  }
  if (now && state.follow && media && !media.paused) now.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

let saveTimers = {};
function autosave(key, fn, savedEl) {
  clearTimeout(saveTimers[key]);
  if (savedEl) savedEl.textContent = 'Kaydediliyor…';
  saveTimers[key] = setTimeout(async () => {
    try {
      await fn();
      if (savedEl) savedEl.textContent = 'Kaydedildi';
    } catch {
      if (savedEl) savedEl.textContent = 'Kaydedilemedi';
    }
  }, 600);
}

function bindTab(d) {
  const body = $('#tab-body');
  if (state.tab === 'transcript') {
    body.querySelectorAll('.seg .time').forEach(b => { b.onclick = () => seek(Number(b.closest('.seg').dataset.start)); });
    const q = $('#tr-q');
    if (q) q.oninput = () => {
      state.trFilter = q.value;
      const pos = q.selectionStart;
      renderTab(d);
      const nq = $('#tr-q');
      nq.focus();
      nq.setSelectionRange(pos, pos);
    };
    const f = $('#tr-follow');
    if (f) f.onchange = () => { state.follow = f.checked; };
    const copy = $('#tr-copy');
    if (copy) copy.onclick = async () => {
      const text = d.segments.map(s => `[${fmtClock(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n');
      await call('clipboard:write', text);
      toast('Döküm panoya kopyalandı');
    };
  } else if (state.tab === 'shots') {
    body.querySelectorAll('.shot').forEach(b => { b.onclick = () => { seek(Number(b.dataset.t)); showShotAt(Number(b.dataset.t)); }; });
  } else if (state.tab === 'notes') {
    const ta = $('#notes');
    ta.oninput = () => {
      d.notes = ta.value;
      autosave('notes', () => api.call('meeting:text', d.id, 'notes', ta.value), $('#notes-saved'));
    };
  } else {
    const toggle = $('#sum-toggle');
    if (toggle) toggle.onclick = () => { state.editingSummary = !state.editingSummary; renderTab(d); };
    const ta = $('#summary');
    if (ta) ta.oninput = () => {
      d.summary = ta.value;
      autosave('summary', () => api.call('meeting:text', d.id, 'summary', ta.value), $('#summary-saved'));
    };
    const saveItems = () => autosave('actions', () => api.call('meeting:update', d.id, { action_items: d.action_items }));
    $('#ai-add').onclick = () => {
      d.action_items = [...(d.action_items || []), { text: '', done: false }];
      renderTab(d);
      $$('#ai-list .action-row input.text').pop()?.focus();
    };
    $('#ai-list').oninput = e => {
      const row = e.target.closest('.action-row');
      if (!row) return;
      const item = d.action_items[Number(row.dataset.i)];
      const k = e.target.dataset.k;
      item[k] = k === 'done' ? e.target.checked : e.target.value;
      if (k === 'done') row.classList.toggle('done', item.done);
      if (item.text.trim()) saveItems();
    };
    $('#ai-list').onclick = e => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      d.action_items.splice(Number(del.dataset.del), 1);
      saveItems();
      renderTab(d);
    };
  }
}

function bindHead(d) {
  const title = $('#title');
  title.onchange = async () => {
    if (!title.value.trim()) { title.value = d.title; return; }
    d.title = title.value.trim();
    await call('meeting:update', d.id, { title: d.title });
    await loadMeetings();
    renderList();
  };
  title.onkeydown = e => { if (e.key === 'Enter') title.blur(); if (e.key === 'Escape') { title.value = d.title; title.blur(); } };
  $('#b-archive').onclick = async () => {
    await call('meeting:archive', [d.id]);
    toast('Arşivleme başladı');
    refresh();
  };
  $('#b-transcribe').onclick = async () => { await call('meeting:transcribe', d.id); refresh(); };
  $('#b-claude').onclick = async () => {
    await call('meeting:claude-prompt', d.id);
    toast('İstek panoya kopyalandı — Claude\'a yapıştırın');
  };
  const re = $('#b-reprocess');
  if (re) re.onclick = async () => { await call('meeting:reprocess', d.id); refresh(); };
  $('#b-folder').onclick = () => call('meeting:reveal', d.id);
  $('#b-delete').onclick = async () => {
    const res = await call('meeting:delete', [d.id]);
    if (res.ok) { state.detail = null; location.hash = '#/'; refresh(); }
  };
}

function renderDetail(d) {
  state.detail = d;
  state.editingSummary = false;
  $('#main').innerHTML = `
    <div class="main-inner">
      <div class="d-head" id="d-head">${headHtml(d)}</div>
      <div id="notices">${noticesHtml(d)}</div>
      <div id="player">${player(d)}</div>
      <nav class="tabs" id="tabs">${tabsHtml(d)}</nav>
      <section id="tab-body"></section>
    </div>`;
  bindHead(d);
  bindPlayer();
  $('#tabs').onclick = e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    renderTab(state.detail);
  };
  renderTab(d);
  renderList();
}

function bindPlayer() {
  const media = $('#media');
  if (media) media.ontimeupdate = syncToMedia;
}

/** Aynı toplantı yeniden yüklendiğinde oynatıcıyı ve yazılmakta olanı bozmadan günceller */
function updateDetail(d) {
  const prev = state.detail;
  state.detail = d;
  const focused = document.activeElement;
  const inHead = focused && $('#d-head')?.contains(focused);
  if (!inHead) { $('#d-head').innerHTML = headHtml(d); bindHead(d); }
  $('#notices').innerHTML = noticesHtml(d);
  if (prev.media_url?.split('?')[0] !== d.media_url?.split('?')[0] || prev.shots.length !== d.shots.length || (!prev.media_url && d.media_url)) {
    $('#player').innerHTML = player(d);
    bindPlayer();
  }
  $('#tabs').innerHTML = tabsHtml(d);
  const editing = focused && $('#tab-body')?.contains(focused) && /INPUT|TEXTAREA/.test(focused.tagName) && focused.type !== 'checkbox';
  const contentChanged = prev.segments.length !== d.segments.length || prev.shots.length !== d.shots.length
    || prev.summary !== d.summary || JSON.stringify(prev.action_items) !== JSON.stringify(d.action_items)
    || prev.transcript?.status !== d.transcript?.status || prev.status !== d.status;
  if (editing) {
    // yazılan metin korunur
    if (state.tab === 'notes') d.notes = $('#notes').value;
    if (state.tab === 'summary' && $('#summary')) d.summary = $('#summary').value;
    d.action_items = prev.action_items;
  } else if (contentChanged) {
    renderTab(d);
  }
}

// ------------------------------------------------------------ izinler, test, Claude

const PERM_ITEMS = [
  { id: 'screen', label: 'Ekran kaydı', hint: 'Ekran videosu ve ekran görüntüleri için; macOS ses kaydına da bu izinle erişir.' },
  { id: 'audio', label: 'Sistem sesi kaydı', hint: 'Karşı tarafın sesini (Teams\'ten gelen sesi) kaydetmek için.' },
  { id: 'mic', label: 'Mikrofon', hint: 'Kendi sesinizi kaydetmek için.' },
];

async function renderPermissions(el) {
  const p = await call('permissions:get').catch(() => ({}));
  const ok = { screen: p.screen === true, audio: p.audio === 'izinli', mic: p.mic === 'izinli' };
  const denied = { screen: p.screen === false, audio: p.audio === 'reddedildi', mic: p.mic === 'reddedildi' };
  el.innerHTML = PERM_ITEMS.map(it => `
    <div class="perm-row">
      <span class="state ${ok[it.id] ? 'ok' : denied[it.id] ? 'bad' : ''}">${icon(ok[it.id] ? 'check' : denied[it.id] ? 'x' : 'question')}</span>
      <div><b>${it.label}</b><div class="muted small">${it.hint}${!ok[it.id] && denied[it.id] && it.id !== 'screen' ? ' <b>Kapalı</b> — Sistem Ayarları\'ndan açın.' : ''}</div></div>
      <div class="inline">
        ${ok[it.id] ? '<span class="badge good">İzinli</span>' : `
          ${denied[it.id] && it.id !== 'screen' ? '' : `<button class="btn sm primary" data-req="${it.id}">İzin ver</button>`}
          <button class="btn sm" data-open="${it.id}">Sistem Ayarları</button>`}
      </div>
    </div>`).join('') + (ok.screen ? '' : '<p class="muted small" style="margin:8px 0 0">Ekran kaydı iznini verdikten sonra Tutanak\'ı kapatıp yeniden açmanız gerekir.</p>')
    + (ok.screen && ok.audio && ok.mic ? '' : `
      <div class="notice info" style="margin:10px 0 0">${icon('question')}<div class="body">
        <b>Sistem Ayarları'nda Tutanak açık göründüğü halde burada izin yok mu diyor?</b>
        O izin Tutanak'ın eski bir sürümüne kayıtlı kalmıştır; macOS onu bu sürüme uygulamaz.
        İzinleri sıfırlayıp her biri için yeniden "İzin ver"e basın.
        <div style="margin-top:8px"><button class="btn sm" id="perm-reset" ${state.app.packaged ? '' : 'disabled'}>${icon('refresh')} İzinleri sıfırla</button></div>
      </div></div>`);
  const reset = el.querySelector('#perm-reset');
  if (reset) reset.onclick = async () => {
    if (await call('permissions:reset').catch(() => false)) {
      toast('İzinler sıfırlandı — şimdi her biri için "İzin ver"e basın');
      renderPermissions(el);
    }
  };
  el.querySelectorAll('[data-req]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      await call('permissions:request', b.dataset.req).catch(() => {});
      renderPermissions(el);
    };
  });
  el.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => call('permissions:open', b.dataset.open); });
}

function testHtml() {
  return `
    <div class="card-head">
      <div><h2>Test kaydı</h2><p class="muted small">6 saniyelik deneme: konuşun ve bu sırada bir video/müzik çalın. Hiçbir şey saklanmaz.</p></div>
      <button class="btn sm" id="test-btn">${icon('record')} Testi başlat</button>
    </div>
    <div class="test-levels" id="test-levels" hidden>
      <span>Mikrofon</span><div class="meter levels"><span id="t-mic"></span></div><span class="num" id="t-mic-v"></span>
      <span>Sistem sesi</span><div class="meter levels"><span id="t-system"></span></div><span class="num" id="t-system-v"></span>
    </div>
    <div id="test-result"></div>`;
}

function bindTest(root) {
  const btn = $('#test-btn', root);
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Kaydediliyor…';
    $('#test-levels', root).hidden = false;
    $('#test-result', root).innerHTML = '';
    let res;
    try { res = await api.call('test:record'); } catch (e) { res = { ok: false, error: e.message }; }
    btn.disabled = false;
    btn.innerHTML = `${icon('record')} Yeniden dene`;
    const out = [];
    if (!res.ok) out.push(`<div class="notice warn">${icon('warn')}<div class="body">${esc(res.error || 'Test başarısız')}</div></div>`);
    else {
      out.push(res.peaks.mic > 0.01 ? '<div class="notice info"><div class="body">✓ Mikrofondan ses alındı.</div></div>'
        : '<div class="notice warn"><div class="body">Mikrofondan ses gelmedi. Konuştuysanız Ayarlar\'dan mikrofonu ve izni kontrol edin.</div></div>');
      out.push(res.peaks.system > 0.01 ? '<div class="notice info"><div class="body">✓ Sistem sesi (karşı taraf) alındı.</div></div>'
        : '<div class="notice warn"><div class="body">Sistem sesi gelmedi. Test sırasında ses çaldıysanız "Sistem sesi kaydı" iznini kontrol edin.</div></div>');
    }
    for (const w of res.warnings || []) out.push(`<div class="notice warn"><div class="body">${esc(w)}</div></div>`);
    $('#test-result', root).innerHTML = out.join('');
  };
}

api.on('test-level', msg => {
  const set = (k, v) => {
    const bar = document.getElementById(`t-${k}`);
    if (bar) bar.style.width = `${Math.min(100, Math.sqrt(v) * 100)}%`;
    const val = document.getElementById(`t-${k}-v`);
    if (val) val.textContent = msg.peaks[k] > 0.01 ? '✓' : '';
  };
  set('mic', msg.mic || 0);
  set('system', msg.system || 0);
});

async function renderClaude(el) {
  const st = await call('claude:status').catch(() => null);
  if (!st) { el.innerHTML = ''; return; }
  const packaged = state.app.packaged;
  el.innerHTML = `
    <p class="muted small" style="margin-top:0">Bağlanınca Claude (sohbet ve Claude Code) toplantılarınızı listeler, dökümleri ve ekran görüntülerini okur, özet ve eylem maddelerini buraya geri yazar. Örnek: <i>"Tutanak'taki bugünkü Teams toplantısını özetle"</i>.</p>
    <div class="inline" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${st.connected && st.up_to_date ? '<span class="badge good">Bağlı</span>' : st.connected ? '<span class="badge warn">Güncellenmeli</span>' : '<span class="badge">Bağlı değil</span>'}
      <button class="btn sm primary" id="claude-connect" ${packaged ? '' : 'disabled title="Yalnızca /Applications\'a kurulu uygulamadan"'}>${st.connected ? 'Yeniden bağla' : 'Claude\'a bağla'}</button>
      <button class="btn sm" id="claude-copy">${icon('copy')} Terminal komutunu kopyala</button>
    </div>
    ${st.connected ? '<p class="muted small">Değişikliğin etkin olması için Claude uygulamasını yeniden başlatın.</p>' : ''}
    <div class="code" style="margin-top:10px">${esc(st.cli_command)}</div>`;
  $('#claude-connect', el).onclick = async () => {
    await call('claude:connect');
    toast('Claude yapılandırmasına eklendi — Claude\'u yeniden başlatın');
    renderClaude(el);
  };
  $('#claude-copy', el).onclick = async () => { await call('clipboard:write', st.cli_command); toast('Komut kopyalandı'); };
}

// ------------------------------------------------------------ karşılama ve ayarlar

function modeCards(current) {
  return `<div class="mode-cards">${state.app.modes.map(m => `
    <button class="mode-card ${m.id === current ? 'on' : ''}" data-mode="${m.id}">
      <b>${icon(MODE_ICON[m.id])} ${esc(m.label)}</b><span>${esc(MODE_HINT[m.id])}</span>
    </button>`).join('')}</div>`;
}

function bindModeCards(root) {
  root.querySelectorAll('.mode-card').forEach(b => {
    b.onclick = async () => {
      await saveSetting({ mode: b.dataset.mode });
      root.querySelectorAll('.mode-card').forEach(x => x.classList.toggle('on', x === b));
    };
  });
}

async function saveSetting(patch) {
  state.app.settings = await call('settings:set', patch);
  renderRec();
}

function renderWelcome() {
  state.detail = null;
  $('#main').innerHTML = `
    <div class="welcome">
      <h1>Tutanak'a hoş geldiniz</h1>
      <p class="lead">Teams'te bir görüşme başladığında sağ üstte "Kaydedilsin mi?" diye soracağım. Onaylarsanız seçtiğiniz biçimde kaydeder, bitince cihaz üzerinde yazılı döküm çıkarırım. Başlamadan önce üç küçük adım:</p>
      <div class="card"><div class="card-head"><div><h2>1. İzinler</h2><p class="muted small">macOS, ekran ve ses kaydı için bir kez izin ister.</p></div></div><div id="perm"></div></div>
      <div class="card" id="test-card">${testHtml()}</div>
      <div class="card"><div class="card-head"><div><h2>2. Varsayılan kayıt biçimi</h2><p class="muted small">Bildirimde her seferinde değiştirebilirsiniz.</p></div></div>${modeCards(state.app.settings.mode)}</div>
      <div class="card"><div class="card-head"><h2>3. Claude bağlantısı</h2></div><div id="claude"></div></div>
      <div style="margin-top:18px;display:flex;gap:8px"><button class="btn primary" id="done">Hazırım</button><a class="btn ghost" href="#/ayarlar">Tüm ayarlar</a></div>
    </div>`;
  renderPermissions($('#perm'));
  bindTest($('#test-card'));
  bindModeCards($('#main'));
  renderClaude($('#claude'));
  $('#done').onclick = async () => { await saveSetting({ onboarded: true }); location.hash = '#/'; route(); };
}

function renderEmpty() {
  state.detail = null;
  $('#main').innerHTML = `
    <div class="hero-empty">
      <div>${icon('audio')}<h2>Henüz kayıt yok</h2>
      <p>Teams'te bir görüşme başladığında sağ üstte soracağım.<br>Elle başlatmak için soldaki <b>Kaydet</b> düğmesini kullanın.</p></div>
    </div>`;
  renderList();
}

function numberField(key, label, hint, unit, min, max) {
  const v = state.app.settings[key];
  return `<div class="field"><label>${label}${hint ? `<div class="hint">${hint}</div>` : ''}</label>
    <div class="inline"><input type="number" data-num="${key}" value="${v}" min="${min}" max="${max}"> <span class="muted">${unit}</span></div></div>`;
}

function toggleField(key, label, hint) {
  return `<div class="field"><label>${label}${hint ? `<div class="hint">${hint}</div>` : ''}</label>
    <div><label class="check"><input type="checkbox" data-bool="${key}" ${state.app.settings[key] ? 'checked' : ''}> Açık</label></div></div>`;
}

async function renderSettings() {
  state.detail = null;
  const s = state.app.settings;
  const ff = state.app.ffmpeg;
  $('#main').innerHTML = `
    <div class="main-inner settings">
      <div><h1>Ayarlar</h1></div>

      <div class="card">
        <div class="card-head"><h2>Kayıt</h2></div>
        <div class="field" style="align-items:start"><label>Varsayılan kayıt biçimi</label>${modeCards(s.mode)}</div>
        <div class="field"><label>Görüşme algılanınca</label>
          <div class="segmented" id="ask">
            <button data-v="ask" class="${s.ask === 'ask' ? 'on' : ''}">Sağ üstte sor</button>
            <button data-v="always" class="${s.ask === 'always' ? 'on' : ''}">Sormadan kaydet</button>
            <button data-v="never" class="${s.ask === 'never' ? 'on' : ''}">Algılama kapalı</button>
          </div></div>
        <div class="field" style="align-items:start"><label>İzlenen uygulamalar<div class="hint">Uygulama mikrofonu açınca görüşme başladı sayılır.</div></label>
          <div class="apps-grid">${state.app.apps.map(a => `<label class="check"><input type="checkbox" data-app="${a.id}" ${s.apps.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}</label>`).join('')}</div></div>
        ${numberField('prompt_timeout_sec', 'Bildirim süresi', 'Yanıt verilmezse bildirim kapanır, kayıt yapılmaz.', 'sn', 5, 600)}
        ${toggleField('auto_stop', 'Görüşme bitince kaydı durdur')}
        ${numberField('end_grace_sec', 'Bitiş için bekleme', 'Uygulama sesi bu kadar süre kullanmazsa görüşme bitmiş sayılır.', 'sn', 5, 600)}
        ${numberField('min_duration_sec', 'Çok kısa kayıtları sil', 'Sormadan kaydet açıkken bundan kısa kayıtlar (ör. yalnızca bekleme ekranı) saklanmaz. 0 = kapalı.', 'sn', 0, 600)}
        <div class="field"><label>Mikrofon</label><select id="mic"><option>Yükleniyor…</option></select></div>
        ${toggleField('system_audio', 'Karşı tarafın sesini kaydet', 'Sistem sesi (Teams\'ten gelen ses).')}
        ${numberField('shot_interval_sec', 'Ekran görüntüsü aralığı', '"Ses + ekran görüntüsü" biçiminde.', 'sn', 5, 600)}
        <div class="field"><label>Video kalitesi<div class="hint">"Ekran videosu" biçiminde.</div></label>
          <div class="inline">
            <select id="video_max_dim" style="width:auto">${[[1280, '1280 px (720p)'], [1920, '1920 px (1080p)'], [2560, '2560 px'], [3840, '3840 px']].map(([v, l]) => `<option value="${v}" ${s.video_max_dim === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select id="video_fps" style="width:auto">${[5, 10, 15, 24, 30].map(v => `<option value="${v}" ${s.video_fps === v ? 'selected' : ''}>${v} kare/sn</option>`).join('')}</select>
          </div></div>
        <div class="field"><label>Kaydedilecek ekran</label><select id="display"><option>Yükleniyor…</option></select></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Döküm</h2></div>
        ${toggleField('auto_transcribe', 'Kayıt bitince döküm çıkar', 'macOS\'un cihaz üzerindeki konuşma tanıması kullanılır; ses hiçbir yere gönderilmez.')}
        <div class="field"><label>Dil</label><select id="transcript_locale">${[['tr-TR', 'Türkçe'], ['en-US', 'İngilizce (ABD)'], ['en-GB', 'İngilizce (BK)'], ['de-DE', 'Almanca'], ['fr-FR', 'Fransızca'], ['es-ES', 'İspanyolca'], ['it-IT', 'İtalyanca'], ['ru-RU', 'Rusça'], ['ar-SA', 'Arapça']].map(([v, l]) => `<option value="${v}" ${s.transcript_locale === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${toggleField('split_speakers', 'Konuşmacıları ayır', 'Mikrofon "Ben", sistem sesi "Katılımcılar" olarak etiketlenir. Hoparlörden sızan yankılar ayıklanır.')}
        <div class="field"><label>Etiketler</label><div class="inline"><input type="text" data-text="me_label" value="${esc(s.me_label)}" style="width:150px"><input type="text" data-text="others_label" value="${esc(s.others_label)}" style="width:150px"></div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Arşiv</h2></div>
        <div class="field"><label>Sıkıştırma<div class="hint">Video HEVC'ye, ses düşük bit hızlı mono AAC'ye çevrilir; ham izler silinir.</div></label>
          <select id="archive_profile">${state.app.profiles.map(p => `<option value="${p.id}" ${s.archive_profile === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
        ${numberField('auto_archive_days', 'Otomatik arşivle', 'Bu kadar günden eski toplantılar kendiliğinden arşivlenir. 0 = kapalı.', 'gün', 0, 3650)}
        <div class="field"><label>Arşiv klasörü<div class="hint">Boşsa arşivlenen toplantı yerinde kalır. Harici disk de seçilebilir.</div></label>
          <div class="inline"><input type="text" readonly value="${esc(s.archive_dir || '— yerinde kalsın —')}" style="flex:1"><button class="btn sm" data-dir="archive_dir">Seç…</button>${s.archive_dir ? '<button class="btn sm ghost" data-clear="archive_dir">Temizle</button>' : ''}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Depolama</h2></div>
        <div class="field"><label>Kayıt klasörü</label>
          <div class="inline"><input type="text" readonly value="${esc(s.library_dir)}" style="flex:1"><button class="btn sm" data-dir="library_dir">Değiştir…</button><button class="btn sm ghost" id="open-lib">Göster</button></div></div>
        <div class="field"><label>ffmpeg</label><div>${ff.ok ? `<span class="badge good">Bulundu</span> <span class="muted small">${esc(ff.bin)}${ff.x265 ? ' · HEVC' : ''}</span>` : '<span class="badge warn">Bulunamadı</span> <span class="muted small">Terminalde <code>brew install ffmpeg</code> çalıştırın.</span>'}</div></div>
      </div>

      <div class="card"><div class="card-head"><h2>İzinler</h2></div><div id="perm"></div></div>
      <div class="card" id="test-card">${testHtml()}</div>
      <div class="card"><div class="card-head"><h2>Claude bağlantısı (MCP)</h2></div><div id="claude"></div></div>

      <div class="card">
        <div class="card-head"><h2>Genel</h2></div>
        <div class="field"><label>Mac açılınca başlat<div class="hint">Görüşmeleri algılayabilmesi için açık olmalı; menü çubuğunda durur.</div></label>
          <label class="check"><input type="checkbox" id="login" ${state.app.open_at_login ? 'checked' : ''} ${state.app.packaged ? '' : 'disabled'}> Açık</label></div>
        <div class="field"><label>Sürüm</label><span class="muted">${esc(state.app.version)}</span></div>
      </div>
    </div>`;
  const root = $('#main');
  bindModeCards(root);
  $('#ask').onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    await saveSetting({ ask: b.dataset.v });
    $$('#ask button').forEach(x => x.classList.toggle('on', x === b));
  };
  root.querySelectorAll('[data-app]').forEach(c => {
    c.onchange = () => saveSetting({ apps: $$('[data-app]', root).filter(x => x.checked).map(x => x.dataset.app) });
  });
  root.querySelectorAll('[data-num]').forEach(i => { i.onchange = () => saveSetting({ [i.dataset.num]: Number(i.value) }); });
  root.querySelectorAll('[data-bool]').forEach(i => { i.onchange = () => saveSetting({ [i.dataset.bool]: i.checked }); });
  root.querySelectorAll('[data-text]').forEach(i => { i.onchange = () => saveSetting({ [i.dataset.text]: i.value }); });
  for (const id of ['video_max_dim', 'video_fps']) $(`#${id}`).onchange = e => saveSetting({ [id]: Number(e.target.value) });
  for (const id of ['transcript_locale', 'archive_profile']) $(`#${id}`).onchange = e => saveSetting({ [id]: e.target.value });
  root.querySelectorAll('[data-dir]').forEach(b => {
    b.onclick = async () => {
      const dir = await call('settings:choose-dir');
      if (dir) { await saveSetting({ [b.dataset.dir]: dir }); renderSettings(); refresh(); }
    };
  });
  root.querySelectorAll('[data-clear]').forEach(b => { b.onclick = async () => { await saveSetting({ [b.dataset.clear]: '' }); renderSettings(); }; });
  $('#open-lib').onclick = () => call('path:reveal', s.library_dir);
  $('#login').onchange = e => saveSetting({ open_at_login: e.target.checked });
  renderPermissions($('#perm'));
  bindTest($('#test-card'));
  renderClaude($('#claude'));

  const dev = await call('devices').catch(() => ({ mics: [], displays: [] }));
  const mics = (dev.mics || []).filter(m => !/MSLoopbackDriver|Teams Audio/i.test(`${m.id} ${m.name}`));
  const micSel = $('#mic');
  if (micSel) {
    micSel.innerHTML = [['default', 'Sistem varsayılanı'], ...mics.map(m => [m.id, `${m.name}${m.default ? ' (varsayılan)' : ''}`]), ['none', 'Mikrofonu kaydetme']]
      .map(([v, l]) => `<option value="${esc(v)}" ${s.mic === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    micSel.onchange = () => saveSetting({ mic: micSel.value });
  }
  const disp = $('#display');
  if (disp) {
    disp.innerHTML = [['auto', 'Otomatik (toplantı penceresinin olduğu ekran)'], ['main', 'Ana ekran'], ...(dev.displays || []).map(d => [String(d.id), `${d.name} (${d.width}×${d.height})`])]
      .map(([v, l]) => `<option value="${esc(v)}" ${String(s.display) === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    disp.onchange = () => saveSetting({ display: disp.value });
  }
}

// ------------------------------------------------------------ yönlendirme

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const hash = location.hash || '#/';
  if (hash.startsWith('#/ayarlar')) { await renderSettings(); renderList(); return; }
  const m = /^#\/m\/(.+)$/.exec(hash);
  if (m) {
    const id = decodeURIComponent(m[1]);
    try {
      const d = await api.call('meeting:get', id);
      if (seq !== routeSeq) return;
      if (state.detail?.id === id && $('#d-head')) updateDetail(d);
      else { state.tab = 'transcript'; state.trFilter = ''; renderDetail(d); }
    } catch {
      location.hash = '#/';
    }
    return;
  }
  if (!state.app.settings.onboarded) { renderWelcome(); renderList(); return; }
  const first = visibleMeetings()[0] || state.meetings[0];
  if (first) location.replace(`#/m/${encodeURIComponent(first.id)}`);
  else renderEmpty();
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await Promise.all([loadApp(), loadMeetings()]);
      renderRec();
      renderJob();
      renderList();
      if (state.detail && /^#\/m\//.test(location.hash)) await route();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

window.addEventListener('hashchange', route);

window.tutanakCommand = (name, arg) => {
  if (name === 'open') location.hash = arg ? `#/m/${encodeURIComponent(arg)}` : '#/';
  else if (name === 'go') location.hash = arg || '#/';
  else if (name === 'search') $('#q').focus();
};

api.on('changed', () => refresh());
api.on('jobs', status => {
  if (state.app) state.app.jobs = status;
  renderJob(status);
  if (state.detail) $('#notices') && ($('#notices').innerHTML = noticesHtml(state.detail));
});
api.on('level', lvl => {
  const set = (k, v) => { const el = document.getElementById(`lvl-${k}`); if (el) el.style.width = `${Math.min(100, Math.sqrt(v) * 100)}%`; };
  set('mic', lvl.mic);
  set('system', lvl.system);
  const t = $('#rec-time');
  if (t && state.app?.recording?.phase === 'recording') t.textContent = fmtClock(lvl.elapsed_sec);
});

api.on('shot', () => {
  const r = state.app?.recording;
  if (!r) return;
  r.shots = (r.shots || 0) + 1;
  const el = document.getElementById('rec-shots');
  if (el) el.textContent = r.shots;
});

setInterval(() => {
  const r = state.app?.recording;
  if (r?.phase === 'recording' && r.started_at) {
    const t = $('#rec-time');
    if (t) t.textContent = fmtClock((Date.now() - r.started_at) / 1000);
  }
}, 1000);

window.addEventListener('focus', () => refresh());

(async () => {
  await refresh();
  await route();
})();
