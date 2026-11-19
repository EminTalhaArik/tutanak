'use strict';
/**
 * Claude için MCP sunucusu: Tutanak'taki toplantıları, dökümleri ve ekran görüntülerini okuma;
 * özet, not ve eylem maddelerini toplantıya geri yazma.
 *
 * MCP "stdio" taşıması: stdin'den satır başına bir JSON-RPC 2.0 mesajı okunur, yanıtlar stdout'a
 * yine satır satır yazılır. stdout yalnızca protokol içindir; günlükler stderr'e.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const ffmpeg = require('./ffmpeg');
const { NotFoundError, NOTES, SUMMARY } = require('./library');
const { MODE_LABELS } = require('./settings');
const { formatTime, toText } = require('./transcript');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Tutanak, kullanıcının Mac'inde kaydettiği toplantıların (çoğunlukla Microsoft Teams) arşividir: kayıt, cihaz üzerinde çıkarılmış döküm, ekran görüntüleri, kullanıcının notları, özet ve eylem maddeleri.

- "Son toplantı", "bugünkü toplantı", "X ile görüşme" gibi isteklerde önce list_meetings (gerekirse query/tarih ile) çağır, doğru toplantıyı bul.
- Özet/tutanak istendiğinde get_meeting + get_transcript oku. Döküm konuşmacıları yalnızca "Ben" (kullanıcının mikrofonu) ve "Katılımcılar" (karşı taraf) olarak ayırır; isimleri bağlamdan çıkarabiliyorsan kullan, emin değilsen uydurma. Döküm otomatik konuşma tanımadır: noktalama yoktur, bazı kelimeler yanlış olabilir; anlamı bağlamdan düzelt.
- Ekranda paylaşılan sunum/doküman önemliyse get_screenshots ile kareleri görüntüle (döküm zamanlarıyla eşleştirebilirsin).
- Özeti hazırlayınca kullanıcı aksini söylemedikçe update_meeting ile toplantıya kaydet: summary (Markdown: kısa özet, alınan kararlar, konuşulan başlıklar, açık sorular) ve action_items (görev, sorumlu, tarih). Kullanıcının kendi notlarını (notes) silme; eklemek için notes_append kullan.
- Eylem maddelerini kullanıcının görev sistemine (ör. Ajanda MCP) eklemeden önce kullanıcıya sor.
- Toplantı id'lerini kullanıcıya gösterme; başlık ve tarihle konuş.`;

const PROMPTS = [
  {
    name: 'toplanti_ozeti',
    title: 'Toplantıyı özetle',
    description: 'Bir toplantının dökümünden tutanak/özet ve eylem maddeleri çıkarır, Tutanak\'a kaydeder',
    arguments: [{ name: 'toplanti', description: 'Toplantının adı ya da tarihi (boşsa en son toplantı)', required: false }],
    text: ({ toplanti }) => `Tutanak'taki ${toplanti ? `"${toplanti}" toplantısını` : 'en son toplantıyı'} bul ve dökümünü oku (gerekirse ekran görüntülerine de bak). Türkçe bir toplantı tutanağı hazırla: 3-5 cümlelik özet, alınan kararlar, konuşulan başlıklar, açık sorular ve eylem maddeleri (kim, ne, ne zaman). Sonra özeti ve eylem maddelerini update_meeting ile toplantıya kaydet ve bana kısaca göster.`,
  },
  {
    name: 'eylem_maddeleri',
    title: 'Eylem maddelerini çıkar',
    description: 'Toplantıdaki görevleri ve takip edilecek işleri listeler',
    arguments: [{ name: 'toplanti', description: 'Toplantının adı ya da tarihi (boşsa en son toplantı)', required: false }],
    text: ({ toplanti }) => `Tutanak'taki ${toplanti ? `"${toplanti}" toplantısının` : 'en son toplantının'} dökümünden bana düşen ve başkalarından beklenen işleri çıkar (kim, ne, ne zaman). update_meeting ile action_items olarak kaydet; görev sistemime eklemek isteyip istemediğimi sor.`,
  },
];

// ------------------------------------------------------------ biçimlendirme

const STATUS_LABELS = {
  recording: 'kaydediliyor', processing: 'işleniyor', ready: 'hazır', archiving: 'arşivleniyor',
  archived: 'arşivlendi', failed: 'başarısız',
};

function brief(m) {
  const o = {
    id: m.id,
    title: m.title,
    started_at: m.started_at,
    duration: formatTime(m.duration_sec || 0),
    mode: MODE_LABELS[m.mode] || m.mode,
    status: STATUS_LABELS[m.status] || m.status,
  };
  if (m.app) o.app = m.app;
  o.transcript = m.transcript?.status === 'done' ? `${m.transcript.words || 0} kelime` : (m.transcript?.status || 'yok');
  if (m.shot_count) o.screenshots = m.shot_count;
  if (m.has_summary) o.has_summary = true;
  if (m.has_notes) o.has_notes = true;
  if (m.action_items?.length) o.action_items = m.action_items.length;
  if (m.tags?.length) o.tags = m.tags;
  return o;
}

function localDay(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function jpegBase64(file, maxDim = 1280) {
  const out = path.join(os.tmpdir(), `tutanak-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', file, '--out', out], e => {
      if (e) return reject(new Error(`Görüntü hazırlanamadı: ${e.message}`));
      try { resolve(fs.readFileSync(out).toString('base64')); } catch (err) { reject(err); } finally { fs.rmSync(out, { force: true }); }
    });
  });
}

async function videoFrame(ff, file, t) {
  const out = path.join(os.tmpdir(), `tutanak-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    await ffmpeg.run(ff.bin, ['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '5', out]);
    return fs.readFileSync(out).toString('base64');
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** times verilmezse aralığa eşit dağılmış count zaman noktası */
function spread(from, to, count) {
  if (count <= 1 || to <= from) return [from];
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

// ------------------------------------------------------------ araçlar

function createTools(lib, settings) {
  const meeting = id => {
    if (!id) throw new NotFoundError('id gerekli (list_meetings ile bulun)');
    return lib.meta(id);
  };

  return [
    {
      name: 'list_meetings',
      title: 'Toplantıları listele / ara',
      description: 'Kaydedilmiş toplantılar, en yeniden eskiye. query başlık, not, özet ve döküm içinde arar; from/to (YYYY-AA-GG) tarih aralığı. Bugünün tarihi de döner.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Aranacak kelime(ler)' },
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Varsayılan 20' },
        },
      },
      annotations: { readOnlyHint: true },
      run: ({ query, from, to, limit = 20 }) => {
        const words = String(query || '').toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
        const all = lib.list({ sizes: false }).filter(m => {
          const day = localDay(m.started_at);
          if (from && day < from) return false;
          if (to && day > to) return false;
          if (!words.length) return true;
          const text = lib.searchText(m.id);
          return words.every(w => text.includes(w));
        });
        return { today: localDay(new Date().toISOString()), total: all.length, meetings: all.slice(0, Math.min(200, limit)).map(brief) };
      },
    },
    {
      name: 'get_meeting',
      title: 'Toplantı ayrıntısı',
      description: 'Bir toplantının bilgileri, kullanıcının notları, kayıtlı özet, eylem maddeleri ve ekran görüntülerinin zamanları. Döküm metni için get_transcript.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: true },
      run: ({ id }) => {
        const m = meeting(id);
        const shots = lib.shots(id);
        return {
          ...brief({ ...m, has_notes: false, has_summary: false }),
          ended_at: m.ended_at,
          notes: lib.text(id, NOTES) || null,
          summary: lib.text(id, SUMMARY) || null,
          action_items: m.action_items || [],
          screenshot_times: shots.length ? shots.map(s => formatTime(s.t)) : undefined,
          video: m.mode === 'video' && m.media ? 'Ekran videosu var; get_screenshots ile istediğin anlardan kare alabilirsin' : undefined,
          warnings: m.warnings?.length ? m.warnings : undefined,
          folder: m.dir,
        };
      },
    },
    {
      name: 'get_transcript',
      title: 'Döküm',
      description: 'Toplantının zaman damgalı dökümü ("[dk:sn] Konuşmacı: metin"). Uzun dökümler parça parça döner; devamı için from_sec kullan.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          from_sec: { type: 'number', minimum: 0 },
          to_sec: { type: 'number', minimum: 0 },
          max_chars: { type: 'integer', minimum: 2000, maximum: 200000, description: 'Varsayılan 80000' },
        },
        required: ['id'],
      },
      annotations: { readOnlyHint: true },
      run: ({ id, from_sec = null, to_sec = null, max_chars = 80000 }) => {
        const m = meeting(id);
        const doc = lib.transcript(id);
        if (!doc?.segments) {
          const st = m.transcript?.status;
          return { title: m.title, transcript: null, note: st === 'running' ? 'Döküm şu anda hazırlanıyor, biraz sonra tekrar dene.' : 'Bu toplantının dökümü yok. Tutanak uygulamasında "Döküm çıkar" ile oluşturulabilir.' };
        }
        let segs = doc.segments.filter(s => (from_sec == null || s.end >= from_sec) && (to_sec == null || s.start <= to_sec));
        let text = '';
        let next = null;
        for (const s of segs) {
          const line = toText([s]);
          if (text.length + line.length > max_chars) { next = Math.floor(s.start); break; }
          text += `${line}\n`;
        }
        segs = null;
        return {
          title: m.title,
          started_at: m.started_at,
          duration: formatTime(m.duration_sec || 0),
          speakers: doc.split_speakers ? '"Ben" = kullanıcının mikrofonu, "Katılımcılar" = karşı taraf' : 'konuşmacılar ayrılmadı',
          engine: doc.engine,
          transcript: text.trimEnd(),
          ...(next != null ? { truncated: true, continue_from_sec: next } : {}),
        };
      },
    },
    {
      name: 'get_screenshots',
      title: 'Ekran görüntüleri',
      description: 'Toplantı sırasında ekranda olanı gösteren kareler (görsel olarak). times_sec ile belirli anlar, ya da from_sec/to_sec aralığından eşit dağılmış "count" kare. Ses + ekran görüntüsü kipinde kayıtlı kareler, video kipinde videodan alınan kareler döner.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          times_sec: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 10 },
          from_sec: { type: 'number', minimum: 0 },
          to_sec: { type: 'number', minimum: 0 },
          count: { type: 'integer', minimum: 1, maximum: 10, description: 'Varsayılan 4' },
        },
        required: ['id'],
      },
      annotations: { readOnlyHint: true },
      run: async ({ id, times_sec, from_sec = 0, to_sec, count = 4 }) => {
        const m = meeting(id);
        const content = [];
        if (m.mode === 'video') {
          const end = to_sec ?? m.duration_sec ?? 0;
          const wanted = (times_sec?.length ? times_sec : spread(from_sec, end, Math.min(10, count))).slice(0, 10);
          const ff = await ffmpeg.info(settings.get('ffmpeg_path'));
          const file = m.media && path.join(m.dir, m.media);
          if (!ff.ok || !file || !fs.existsSync(file)) return [{ type: 'text', text: 'Videodan kare alınamadı (ffmpeg ya da video yok).' }];
          for (const t of wanted) {
            content.push({ type: 'text', text: `Kare @ ${formatTime(t)}` });
            content.push({ type: 'image', data: await videoFrame(ff, file, t), mimeType: 'image/jpeg' });
          }
          return content;
        }
        const shots = lib.shots(id);
        if (!shots.length) return [{ type: 'text', text: 'Bu toplantıda ekran görüntüsü yok (yalnızca ses kaydı).' }];
        let picked;
        if (times_sec?.length) {
          // her an için o anda ekranda olan (son alınmış) kare
          picked = [...new Set(times_sec.slice(0, 10).map(t => {
            const before = shots.filter(s => s.t <= t + 1);
            return (before.length ? before[before.length - 1] : shots[0]).file;
          }))];
        } else {
          const inRange = shots.filter(s => s.t >= from_sec - 1 && (to_sec == null || s.t <= to_sec + 1));
          const pool = inRange.length ? inRange : shots;
          const n = Math.min(10, count, pool.length);
          picked = [...new Set(Array.from({ length: n }, (_, i) => pool[Math.round((i * (pool.length - 1)) / Math.max(1, n - 1))].file))];
        }
        for (const file of picked) {
          const s = shots.find(x => x.file === file);
          content.push({ type: 'text', text: `Ekran @ ${formatTime(s.t)}` });
          content.push({ type: 'image', data: await jpegBase64(path.join(m.dir, file)), mimeType: 'image/jpeg' });
        }
        return content;
      },
    },
    {
      name: 'search_transcripts',
      title: 'Dökümlerde ara',
      description: 'Tüm toplantı dökümlerinde bir ifadeyi arar; eşleşen satırları zamanlarıyla döndürür ("bu konu hangi toplantıda konuşulmuştu?").',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Varsayılan 30 satır' } },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      run: ({ query, limit = 30 }) => {
        const words = String(query).toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
        if (!words.length) throw new Error('query boş olamaz');
        const hits = [];
        for (const m of lib.list({ sizes: false })) {
          if (hits.length >= limit) break;
          if (!words.every(w => lib.searchText(m.id).includes(w))) continue;
          const segs = lib.transcript(m.id)?.segments || [];
          for (const s of segs) {
            const t = s.text.toLocaleLowerCase('tr');
            if (words.some(w => t.includes(w))) {
              hits.push({ meeting: m.title, id: m.id, date: m.started_at, at: formatTime(s.start), speaker: s.speaker || undefined, text: s.text });
              if (hits.length >= limit) break;
            }
          }
        }
        return { query, hits };
      },
    },
    {
      name: 'update_meeting',
      title: 'Toplantıyı güncelle',
      description: 'Toplantıya özet (Markdown), eylem maddeleri, etiket ya da yeni başlık yazar; notes_append kullanıcının notlarının sonuna ekler. Verilmeyen alanlar değişmez.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'Markdown özet/tutanak; öncekinin yerine geçer' },
          notes_append: { type: 'string', description: 'Kullanıcının notlarının sonuna eklenecek metin' },
          action_items: {
            type: 'array',
            description: 'Eylem maddeleri (öncekilerin yerine geçer)',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                owner: { type: 'string', description: 'Sorumlu kişi' },
                due: { type: 'string', description: 'Tarih (YYYY-AA-GG) ya da serbest metin' },
                done: { type: 'boolean' },
              },
              required: ['text'],
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
      run: ({ id, title, summary, notes_append, action_items, tags }) => {
        meeting(id);
        const patch = {};
        if (typeof title === 'string' && title.trim()) patch.title = title.trim().slice(0, 200);
        if (Array.isArray(action_items)) {
          patch.action_items = action_items.filter(a => a && String(a.text || '').trim()).map(a => ({
            text: String(a.text).trim(), owner: a.owner ? String(a.owner) : undefined, due: a.due ? String(a.due) : undefined,
            done: Boolean(a.done), by: 'claude',
          }));
        }
        if (Array.isArray(tags)) patch.tags = [...new Set(tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))];
        if (typeof summary === 'string') lib.setText(id, SUMMARY, summary.trim() + '\n');
        if (typeof notes_append === 'string' && notes_append.trim()) {
          const prev = lib.text(id, NOTES).trimEnd();
          lib.setText(id, NOTES, `${prev ? `${prev}\n\n` : ''}${notes_append.trim()}\n`);
        }
        const m = lib.update(id, patch);
        return { ok: true, meeting: brief({ ...m, has_summary: typeof summary === 'string' }) };
      },
    },
  ];
}

// ------------------------------------------------------------ protokol

function createMcpServer({ lib, settings }, { version = '1.0.0' } = {}) {
  const tools = createTools(lib, settings);
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function callTool(params) {
    const tool = tools.find(t => t.name === params?.name);
    if (!tool) return null;
    try {
      settings.load(); // uygulamada değişmiş olabilir
      const result = await tool.run(params.arguments || {});
      if (Array.isArray(result)) return { content: result };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (e) {
      if (!(e instanceof NotFoundError)) console.error(`[tutanak-mcp] ${tool.name}:`, e);
      return { content: [{ type: 'text', text: `Hata: ${e.message}` }], isError: true };
    }
  }

  async function handle(msg) {
    const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isRequest ? fail(msg.id, -32600, 'Geçersiz istek') : null;
    }
    const { id, method, params } = msg;
    if (!isRequest) return null;
    try {
      switch (method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: 'tutanak', title: 'Tutanak', version },
            instructions: INSTRUCTIONS,
          });
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: tools.map(({ run, ...t }) => t) });
        case 'tools/call': {
          const result = await callTool(params);
          return result ? ok(id, result) : fail(id, -32602, `Bilinmeyen araç: ${params?.name}`);
        }
        case 'prompts/list':
          return ok(id, { prompts: PROMPTS.map(({ text, ...p }) => p) });
        case 'prompts/get': {
          const p = PROMPTS.find(x => x.name === params?.name);
          if (!p) return fail(id, -32602, `Bilinmeyen istem: ${params?.name}`);
          return ok(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(params.arguments || {}) } }] });
        }
        default:
          return fail(id, -32601, `Bilinmeyen yöntem: ${method}`);
      }
    } catch (e) {
      console.error('[tutanak-mcp]', e);
      return fail(id, -32603, e.message);
    }
  }

  return { handle, tools };
}

/** stdin/stdout üzerinden sunar; stdin kapanınca süreç biter. */
function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const write = msg => output.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON ayrıştırılamadı' } });
        return;
      }
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(m => server.handle(m)))).filter(Boolean);
        if (out.length) write(out);
      } else {
        const out = await server.handle(msg);
        if (out) write(out);
      }
    });
  });
  // stdout bir boru olduğunda yazımlar eşzamansızdır: büyük yanıtlar (görüntüler) tamamen gitmeden çıkılmasın
  rl.on('close', () => queue.then(() => output.write('', () => process.exit(0))));
}

module.exports = { createMcpServer, serveStdio, PROTOCOL_VERSIONS, INSTRUCTIONS };
