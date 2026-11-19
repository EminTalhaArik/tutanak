'use strict';
/**
 * Claude bağlantısı: Claude masaüstü uygulamasının MCP yapılandırmasına
 * (claude_desktop_config.json → mcpServers.tutanak) Tutanak sunucusunu ekler ve durumunu okur.
 * Bu yapılandırmayı hem Claude sohbetleri hem de masaüstündeki Claude Code oturumları kullanır.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_NAME = 'tutanak';
const CONFIG_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const SCRIPT = path.join(__dirname, '..', 'mcp-server.js');

/**
 * Claude'un başlatacağı komut. Uygulama içinden (Electron) çağrıldığında uygulamanın kendi
 * çalıştırılabilir dosyası Node gibi kullanılır; böylece sistemde ayrıca Node gerekmez.
 */
function serverSpec({ electron = Boolean(process.versions.electron) } = {}) {
  return electron
    ? { command: process.execPath, args: [SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: process.execPath, args: [SCRIPT] };
}

function quote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Terminaldeki Claude Code (claude CLI) için eşdeğer komut. */
function cliCommand(spec) {
  const env = Object.entries(spec.env || {}).map(([k, v]) => `-e ${k}=${v} `).join('');
  return `claude mcp add ${SERVER_NAME} --scope user ${env}-- ${[spec.command, ...spec.args].map(quote).join(' ')}`;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Claude yapılandırması okunamadı: ${e.message}`);
  }
}

function sameSpec(a, b) {
  return a && a.command === b.command && JSON.stringify(a.args || []) === JSON.stringify(b.args || [])
    && JSON.stringify(a.env || {}) === JSON.stringify(b.env || {});
}

function status(spec = serverSpec()) {
  let config = null;
  let error = null;
  try { config = readConfig(); } catch (e) { error = e.message; }
  const entry = config?.mcpServers?.[SERVER_NAME] || null;
  return {
    config_file: CONFIG_FILE,
    claude_installed: fs.existsSync(path.dirname(CONFIG_FILE)),
    connected: Boolean(entry),
    up_to_date: sameSpec(entry, spec),
    error,
    cli_command: cliCommand(spec),
  };
}

/** mcpServers.tutanak girdisini ekler/günceller; diğer ayarlara dokunmaz, önce yedek alır. */
function connect(spec = serverSpec()) {
  const config = readConfig() || {};
  // Dosyada API anahtarları olabilir: mevcut izinler (ör. yalnızca kullanıcı) korunur
  let mode = 0o600;
  if (fs.existsSync(CONFIG_FILE)) {
    mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.tutanak-oncesi.bak`);
  }
  config.mcpServers = { ...(config.mcpServers || {}), [SERVER_NAME]: spec };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, CONFIG_FILE);
  return status(spec);
}

module.exports = { serverSpec, status, connect, cliCommand, SERVER_NAME };
