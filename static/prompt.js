'use strict';
/* Sağ üstteki bildirim: "Kaydedilsin mi?", "Kayıt başladı", "Kayıt tamamlandı", hata. */

const api = window.tutanak;
const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const X = '<svg viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8"/></svg>';

let data = null;
let mode = null;
let hideAt = 0;
let total = 0;
let hovering = false;
let pausedAt = 0;

const answer = (action, extra = {}) => api.call('prompt:answer', { action, ...extra }).catch(() => {});

function head(label) {
  return `<div class="head"><span class="logo"><i></i></span><span class="label">${label}</span><button class="x" data-a="close" title="Kapat">${X}</button></div>`;
}

function render() {
  if (!data) return;
  let html = '';
  let seconds = 0;
  switch (data.kind) {
    case 'ask':
      seconds = data.timeout || 45;
      html = `${head(`${esc(data.app || 'Toplantı')} görüşmesi algılandı`)}
        <div class="title">${esc(data.title)}</div>
        <div class="sub">Bu görüşme kaydedilsin mi?</div>
        <div class="modes">${(data.modes || []).map(m => `<button data-mode="${m.id}" class="${m.id === mode ? 'on' : ''}">${esc(m.label.replace('Yalnızca ses', 'Ses').replace('Ses + ekran görüntüsü', 'Ses + kare').replace('Ekran videosu', 'Video'))}</button>`).join('')}</div>
        <div class="row"><button class="rec" data-a="record">Kaydet</button><button data-a="dismiss">Bu sefer değil</button></div>
        <div class="timer" id="timer"></div>`;
      break;
    case 'recording':
      seconds = 6;
      html = `${head('Tutanak')}
        <div class="title"><span class="dot"></span>${data.auto ? 'Görüşme kaydediliyor' : 'Kayıt başladı'}</div>
        <div class="sub">${esc(data.title)} · ${esc(data.mode_label)}</div>
        <div class="row"><button data-a="stop">Kaydı bitir</button>${data.auto ? '<button data-a="cancel">Kaydetme</button>' : ''}<button data-a="close">Gizle</button></div>
        <div class="timer" id="timer"></div>`;
      break;
    case 'finished':
      seconds = data.warnings?.length ? 25 : 12;
      html = `${head('Tutanak')}
        <div class="title"><span class="ok">✓</span>Kayıt tamamlandı</div>
        <div class="sub">${esc(data.title)} · ${esc(data.duration)}${data.transcribing ? ' · döküm hazırlanıyor' : ''}</div>
        ${data.warnings?.length ? `<div class="warn">${esc(data.warnings[0])}</div>` : ''}
        <div class="row"><button class="primary" data-a="open">Aç</button><button data-a="close">Kapat</button></div>
        <div class="timer" id="timer"></div>`;
      break;
    case 'error':
      seconds = 30;
      html = `${head('Tutanak')}
        <div class="title">${esc(data.title)}</div>
        <div class="sub">${esc(data.message)}</div>
        <div class="row">${data.action ? '<button class="primary" data-a="permissions">Ayarları aç</button>' : ''}<button data-a="close">Kapat</button></div>`;
      break;
  }
  root.innerHTML = html;
  total = seconds * 1000;
  hideAt = Date.now() + total;
  requestAnimationFrame(() => api.call('prompt:resize', Math.ceil(root.getBoundingClientRect().height)).catch(() => {}));
}

root.addEventListener('click', e => {
  const m = e.target.closest('[data-mode]');
  if (m) {
    mode = m.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b === m));
    return;
  }
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const action = b.dataset.a;
  if (action === 'record') {
    b.disabled = true;
    b.textContent = 'Başlatılıyor…';
  }
  answer(action, action === 'record' ? { mode } : {});
});

root.addEventListener('mouseenter', () => { hovering = true; pausedAt = Date.now(); });
root.addEventListener('mouseleave', () => {
  hovering = false;
  if (pausedAt) hideAt += Date.now() - pausedAt;
  pausedAt = 0;
});

setInterval(() => {
  if (!data || !total || hovering) return;
  const left = hideAt - Date.now();
  const bar = document.getElementById('timer');
  if (bar) bar.style.transform = `scaleX(${Math.max(0, left / total)})`;
  if (left <= 0) {
    // Yanıtsız soru: bu görüşme için bir daha sorma
    answer(data.kind === 'ask' ? 'dismiss' : 'close');
    data = null;
  }
}, 100);

api.on('prompt', d => {
  data = d;
  mode = d.mode || null;
  render();
});
