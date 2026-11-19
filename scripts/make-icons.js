'use strict';
/**
 * Uygulama simgesini (build/icon.png + icon.iconset) ve menü çubuğu simgelerini
 * (assets/trayTemplate*.png, assets/trayRecording*.png) SVG'den üretir. Çalıştırma: npm run icons
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1fa293"/><stop offset="1" stop-color="#0b5d55"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#04302b" flood-opacity=".35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <g filter="url(#sh)"><rect x="252" y="214" width="452" height="580" rx="64" fill="#fff"/></g>
  <path d="M330 340h296" stroke="#0f766e" stroke-width="34" stroke-linecap="round"/>
  <path d="M330 432h296" stroke="#cfe9e5" stroke-width="34" stroke-linecap="round"/>
  <path d="M330 524h200" stroke="#cfe9e5" stroke-width="34" stroke-linecap="round"/>
  <g stroke="#0f766e" stroke-width="26" stroke-linecap="round">
    <path d="M338 640v40M394 616v88M450 600v120M506 626v68"/>
  </g>
  <circle cx="694" cy="702" r="118" fill="#ff4d40" stroke="#fff" stroke-width="30"/>
  <circle cx="694" cy="702" r="44" fill="#fff"/>
</svg>`;

// Şablon görüntü: yalnızca saydamlık kullanılır, macOS açık/koyu menü çubuğuna göre renklendirir
const TRAY_ICON = size => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect x="5" y="3.5" width="18" height="24" rx="4" fill="none" stroke="#000" stroke-width="2.6"/>
  <path d="M10 10h8M10 15h5" stroke="#000" stroke-width="2.6" stroke-linecap="round"/>
  <circle cx="23.5" cy="23.5" r="6.5" fill="#000"/>
</svg>`;

const TRAY_REC = size => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="11" fill="#ff3b30"/>
  <circle cx="16" cy="16" r="4.5" fill="#fff"/>
</svg>`;

let win;
async function render(svg, size, out) {
  win ||= new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`)}`);
  await new Promise(r => setTimeout(r, 400));
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  if (img.getSize().width !== size) img = img.resize({ width: size, height: size, quality: 'best' });
  fs.writeFileSync(out, img.toPNG());
}

app.whenReady().then(async () => {
  const build = path.join(ROOT, 'build');
  const iconset = path.join(build, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const master = path.join(build, 'icon.png');
  await render(APP_ICON, 1024, master);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const px = s * scale;
      execFileSync('sips', ['-z', String(px), String(px), master, '--out', path.join(iconset, `icon_${s}x${s}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  // Çok küçük pencereler çizilemediği için büyük çizilip küçültülür
  const assets = path.join(ROOT, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const [svg, name] of [[TRAY_ICON, 'trayTemplate'], [TRAY_REC, 'trayRecording']]) {
    const big = path.join(build, `${name}.png`);
    await render(svg(256), 256, big);
    for (const [px, suffix] of [[16, ''], [32, '@2x']]) {
      execFileSync('sips', ['-z', String(px), String(px), big, '--out', path.join(assets, `${name}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  console.log('Simgeler üretildi');
  app.quit();
});
