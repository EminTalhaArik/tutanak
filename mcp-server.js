'use strict';
/**
 * Tutanak MCP sunucusu — Claude'un toplantı kayıtlarını, dökümleri ve ekran görüntülerini
 * okuyup özet/eylem maddesi yazabilmesi için (stdio).
 *
 * Kurulu uygulamadan: ELECTRON_RUN_AS_NODE=1 /Applications/Tutanak.app/Contents/MacOS/Tutanak <bu dosya>
 * Geliştirmede:       node mcp-server.js   (TUTANAK_DATA_DIR / TUTANAK_LIBRARY_DIR ile başka klasör)
 */
// stdout yalnızca MCP protokolü içindir; yanlışlıkla yazılan günlükler stderr'e gitsin
console.log = console.info = console.debug = console.error;

const { Settings } = require('./src/settings');
const { Library } = require('./src/library');
const { createMcpServer, serveStdio } = require('./src/mcp');
const { version } = require('./package.json');

const settings = new Settings();
const lib = new Library(() => ({ library: settings.libraryDir(), archive: settings.get('archive_dir') }));
serveStdio(createMcpServer({ lib, settings }, { version }));
