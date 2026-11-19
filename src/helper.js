'use strict';
/**
 * Swift yardımcısını (bin/tutanak-helper) çalıştırır. Yardımcı stdout'a satır başına bir JSON
 * nesnesi yazar; "event": "error" satırı hata sayılır.
 */
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { helperPath } = require('./paths');

class HelperError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.kind = kind;
  }
}

/** Uzun süren komutlar (watch, record): her satır için onEvent çağrılır */
function start(args, { onEvent = () => {}, onExit = () => {} } = {}) {
  const bin = helperPath();
  if (!bin) throw new HelperError('Yardımcı araç bulunamadı (npm run helper ile derleyin)');
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    try { onEvent(msg); } catch (e) { console.error('[tutanak-helper]', e); }
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.on('error', e => onExit(-1, e.message));
  child.on('close', code => onExit(code, stderr));
  child.stdin.on('error', () => {});
  return child;
}

/** Tek seferlik komut: son JSON nesnesiyle çözülür, hata satırında reddedilir */
function run(args, { onEvent = () => {}, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let last = null;
    let error = null;
    let timer = null;
    const child = start(args, {
      onEvent: msg => {
        if (msg.event === 'error') error = new HelperError(msg.error, msg.kind);
        else last = msg;
        onEvent(msg);
      },
      onExit: (code, stderr) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (code !== 0 && !last) reject(new HelperError(`Yardımcı araç hata verdi (${code}): ${String(stderr).trim().slice(-300)}`));
        else resolve(last || {});
      },
    });
    child.stdin.end();
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  });
}

module.exports = { start, run, HelperError };
