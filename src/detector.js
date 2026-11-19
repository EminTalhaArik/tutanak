'use strict';
/**
 * Toplantı algılama: yardımcı araç CoreAudio'dan mikrofonu/hoparlörü kullanan süreçleri bildirir.
 * İzlenen bir uygulama (ör. Teams) mikrofonu birkaç saniye açık tutunca görüşme başlamış,
 * mikrofonu da hoparlörü de bir süre kullanmayınca bitmiş sayılır.
 */
const { EventEmitter } = require('node:events');
const helper = require('./helper');

const APPS = {
  teams: {
    name: 'Microsoft Teams', short: 'Teams',
    bundles: ['com.microsoft.teams'], paths: ['/Microsoft Teams.app/', '/Microsoft Teams classic.app/'],
    focus: ['com.microsoft.teams2', 'com.microsoft.teams'],
    suffix: /\s*\|\s*Microsoft Teams.*$/i,
  },
  zoom: { name: 'Zoom', short: 'Zoom', bundles: ['us.zoom.'], paths: ['/zoom.us.app/'], focus: ['us.zoom.xos'], suffix: /\s*[-|]\s*Zoom.*$/i },
  webex: { name: 'Webex', short: 'Webex', bundles: ['com.cisco.webex', 'Cisco-Systems.Spark'], paths: ['/Webex.app/', '/Cisco Webex Meetings.app/'], focus: ['Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp'] },
  slack: { name: 'Slack (huddle)', short: 'Slack', bundles: ['com.tinyspeck.slackmacgap'], paths: ['/Slack.app/'], focus: ['com.tinyspeck.slackmacgap'] },
  whatsapp: { name: 'WhatsApp', short: 'WhatsApp', bundles: ['net.whatsapp.WhatsApp', 'desktop.WhatsApp'], paths: ['/WhatsApp.app/'], focus: ['net.whatsapp.WhatsApp'] },
  facetime: { name: 'FaceTime', short: 'FaceTime', bundles: ['com.apple.FaceTime'], paths: ['/FaceTime.app/'], focus: ['com.apple.FaceTime'] },
  browser: {
    name: 'Tarayıcı (Meet, Teams web…)', short: 'Tarayıcı',
    bundles: ['com.google.Chrome', 'com.microsoft.edgemac', 'company.thebrowser.Browser', 'com.brave.Browser', 'org.mozilla.firefox', 'com.apple.Safari', 'com.apple.WebKit'],
    paths: ['/Google Chrome.app/', '/Microsoft Edge.app/', '/Arc.app/', '/Brave Browser.app/', '/Firefox.app/'],
    focus: ['com.google.Chrome', 'com.microsoft.edgemac', 'company.thebrowser.Browser', 'com.brave.Browser', 'org.mozilla.firefox', 'com.apple.Safari'],
  },
};

const START_MS = 2500;
const GENERIC = /^(chat|sohbet|activity|etkinlik|calendar|takvim|teams|ekipler|calls?|aramalar|files|dosyalar|onedrive|apps|uygulamalar|copilot|communities|topluluklar|people|kişiler|notifications|bildirimler|settings|ayarlar|assignments|microsoft teams|zoom|zoom workplace|home|giriş)$/i;

function matches(app, proc) {
  const bundle = proc.bundle || '';
  return app.bundles.some(b => bundle.startsWith(b)) || app.paths.some(p => (proc.path || '').includes(p));
}

/** Toplantı penceresinin başlığından toplantı adını tahmin eder */
function pickTitle(appKey, windows) {
  const app = APPS[appKey];
  if (!app) return null;
  const titles = windows
    .filter(w => app.focus.some(b => (w.bundle || '').startsWith(b)) && w.title)
    .map(w => (app.suffix ? w.title.replace(app.suffix, '') : w.title).trim())
    .filter(t => t && !GENERIC.test(t.split('|')[0].trim()) && !/^microsoft teams/i.test(t));
  return titles[0] || null;
}

async function meetingTitle(appKey) {
  try {
    const { windows = [] } = await helper.run(['windows'], { timeoutMs: 5000 });
    return pickTitle(appKey, windows);
  } catch {
    return null;
  }
}

class Detector extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.procs = [];
    this.state = {};
    this.child = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.spawn();
    this.timer = setInterval(() => this.evaluate(), 1000);
  }

  spawn() {
    try {
      this.child = helper.start(['watch', '--interval', '1'], {
        onEvent: msg => {
          if (msg.event === 'audio') {
            this.procs = msg.procs || [];
            this.evaluate();
          }
        },
        onExit: () => {
          this.child = null;
          if (!this.stopped) setTimeout(() => !this.stopped && this.spawn(), 3000);
        },
      });
    } catch (e) {
      console.error('Tutanak algılayıcı:', e.message);
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.child?.stdin.end();
    this.child?.kill();
  }

  evaluate(now = Date.now()) {
    const s = this.getSettings();
    for (const [key, app] of Object.entries(APPS)) {
      const enabled = s.ask !== 'never' && (s.apps || []).includes(key);
      const own = this.procs.filter(p => matches(app, p));
      const input = own.some(p => p.input);
      const output = own.some(p => p.output);
      const st = (this.state[key] ||= { inputSince: null, lastActive: 0, active: false });
      st.inputSince = input ? st.inputSince ?? now : null;
      if (input || output) st.lastActive = now;
      if (!st.active && enabled && st.inputSince != null && now - st.inputSince >= START_MS) {
        st.active = true;
        st.startedAt = now;
        this.emit('start', { key, app });
      } else if (st.active && !input && !output && now - st.lastActive >= (s.end_grace_sec || 20) * 1000) {
        st.active = false;
        this.emit('end', { key, app });
      }
    }
  }

  isActive(key) {
    return Boolean(this.state[key]?.active);
  }

  activeKeys() {
    return Object.keys(this.state).filter(k => this.state[k].active);
  }
}

module.exports = { Detector, APPS, matches, pickTitle, meetingTitle };
