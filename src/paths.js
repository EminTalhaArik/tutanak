'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Ayarların tutulduğu klasör (masaüstü uygulaması ve MCP sunucusu ortak kullanır).
 * Geliştirmede TUTANAK_DATA_DIR ile başka bir klasör verilebilir.
 */
function dataDir() {
  return process.env.TUTANAK_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Tutanak');
}

/** Kayıtların varsayılan yeri; Masaüstü/Belgeler iCloud'a eşitlenebildiği için Filmler altı */
function defaultLibraryDir() {
  return process.env.TUTANAK_LIBRARY_DIR || path.join(os.homedir(), 'Movies', 'Tutanak');
}

/** Swift yardımcısı; paketli uygulamada asar dışına (app.asar.unpacked) çıkarılır */
function helperPath() {
  const p = path.join(__dirname, '..', 'bin', 'tutanak-helper').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(p) ? p : null;
}

module.exports = { dataDir, defaultLibraryDir, helperPath };
