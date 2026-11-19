'use strict';
/**
 * Uçtan uca: ham izlerden birleştirme, konuşmacılı döküm, arşivleme ve MCP araçları.
 * Gerçek ffmpeg (Homebrew) ve derlenmiş yardımcı aracı (bin/tutanak-helper) kullanır.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutanak-test-'));
process.env.TUTANAK_DATA_DIR = path.join(tmp, 'veri');
process.env.TUTANAK_LIBRARY_DIR = path.join(tmp, 'kayitlar');

const { Settings } = require('../src/settings');
const { Library, dirSize } = require('../src/library');
const ffmpeg = require('../src/ffmpeg');
const { mix, transcribe } = require('../src/processing');
const { archiveMeeting } = require('../src/archive');
const { createMcpServer } = require('../src/mcp');

const FIX = path.join(__dirname, 'fixtures');
const settings = new Settings();
const lib = new Library(() => ({ library: settings.libraryDir(), archive: settings.get('archive_dir') }));

function makeShots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ff = ffmpeg.find();
  const shot = (src, name) => execFileSync(ff, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-q:v', '2', path.join(dir, name)]);
  shot('testsrc=size=1920x800', '000001.jpg');
  shot('testsrc=size=1920x800', '000031.jpg'); // aynısı: arşivde ayıklanmalı
  shot('smptebars=size=1920x800', '000061.jpg');
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ses + kare toplantısı: birleştir, dök, arşivle, MCP', async () => {
  const ff = await ffmpeg.info();
  assert.ok(ff.ok, 'ffmpeg gerekli');
  let m = lib.create({ title: 'Sprint planlama', app: 'Teams', app_key: 'teams', mode: 'shots', created_by: 'auto' });
  for (const f of ['mikrofon.m4a', 'sistem.m4a']) fs.copyFileSync(path.join(FIX, f), path.join(m.dir, f));
  makeShots(path.join(m.dir, 'kareler'));
  m = lib.update(m.id, { status: 'processing', duration_sec: 19, shot_count: 3 });

  const media = await mix(m, { ff });
  assert.equal(media, 'ses.m4a');
  const dur = await ffmpeg.duration(ff.probe, path.join(m.dir, media));
  assert.ok(dur > 17 && dur < 22, `süre ${dur}`);
  m = lib.update(m.id, { media, status: 'ready' });

  const t = await transcribe(m, settings.all(), { ff });
  assert.equal(t.status, 'done');
  assert.ok(t.split_speakers);
  const doc = lib.transcript(m.id);
  const speakers = new Set(doc.segments.map(s => s.speaker));
  assert.deepEqual([...speakers].sort(), ['Ben', 'Katılımcılar']);
  const others = doc.segments.find(s => s.speaker === 'Katılımcılar');
  assert.ok(others.start >= 7.5, `karşı taraf 8.5 sn'de başlıyor, döküm ${others.start}`);
  assert.match(doc.segments.map(s => s.text).join(' ').toLocaleLowerCase('tr'), /rapor ekranı/);
  m = lib.update(m.id, { transcript: t });

  // MCP
  const server = createMcpServer({ lib, settings });
  const callTool = async (name, args) => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.ok(!res.result.isError, JSON.stringify(res.result));
    return res.result.content;
  };
  const list = JSON.parse((await callTool('list_meetings', { query: 'rapor' }))[0].text);
  assert.equal(list.meetings.length, 1);
  const tr = JSON.parse((await callTool('get_transcript', { id: m.id }))[0].text);
  assert.match(tr.transcript, /\[00:0\d\] Ben: /);
  const shots = await callTool('get_screenshots', { id: m.id, count: 2 });
  assert.equal(shots.filter(c => c.type === 'image').length, 2);
  assert.ok(shots.find(c => c.type === 'image').data.length > 1000);
  await callTool('update_meeting', { id: m.id, summary: '# Özet\n- Rapor ekranı bitti', action_items: [{ text: 'Dışa aktarmayı bitir', owner: 'Ekip', due: 'Cuma' }], notes_append: 'Claude notu' });
  const got = JSON.parse((await callTool('get_meeting', { id: m.id }))[0].text);
  assert.match(got.summary, /Rapor ekranı bitti/);
  assert.equal(got.action_items[0].owner, 'Ekip');
  assert.match(got.notes, /Claude notu/);
  const hits = JSON.parse((await callTool('search_transcripts', { query: 'cuma' }))[0].text);
  assert.ok(hits.hits.length >= 1);

  // Arşiv
  const before = dirSize(m.dir);
  const res = await archiveMeeting(lib, m.id, { ff, settings: settings.all() });
  m = lib.meta(m.id);
  assert.equal(m.status, 'archived');
  assert.ok(res.after < before, `${before} → ${res.after}`);
  assert.ok(!fs.existsSync(path.join(m.dir, 'mikrofon.m4a')));
  assert.equal(lib.shots(m.id).length, 2, 'aynı kare ayıklanmalı');
  assert.ok(fs.existsSync(path.join(m.dir, 'ses.m4a')));
});

test('video toplantısı: ekran + sesler tek mp4, arşivde HEVC', async () => {
  const ff = await ffmpeg.info();
  let m = lib.create({ title: 'Demo', app: 'Teams', app_key: 'teams', mode: 'video' });
  execFileSync(ff.bin, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x800:rate=15', '-t', '19', '-c:v', 'libx264', '-b:v', '3M', '-pix_fmt', 'yuv420p', path.join(m.dir, 'ekran.mp4')]);
  for (const f of ['mikrofon.m4a', 'sistem.m4a']) fs.copyFileSync(path.join(FIX, f), path.join(m.dir, f));
  m = lib.update(m.id, { status: 'processing', duration_sec: 19 });
  const media = await mix(m, { ff });
  assert.equal(media, 'kayit.mp4');
  assert.ok(!fs.existsSync(path.join(m.dir, 'ekran.mp4')));
  const streams = execFileSync(ff.probe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', path.join(m.dir, media)]).toString();
  assert.match(streams, /h264,video/);
  assert.match(streams, /aac,audio/);
  m = lib.update(m.id, { media, status: 'ready', transcript: { status: 'done' } });
  const before = fs.statSync(path.join(m.dir, media)).size;
  await archiveMeeting(lib, m.id, { ff, settings: { ...settings.all(), auto_transcribe: false } });
  const after = execFileSync(ff.probe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(m.dir, media)]).toString();
  assert.match(after, /hevc/);
  assert.ok(fs.statSync(path.join(m.dir, media)).size < before);
});

test('sistem sesi sessizse konuşmacılar ayrılmaz (her şey "Ben" olmasın)', async () => {
  const ff = await ffmpeg.info();
  let m = lib.create({ title: 'Sessiz sistem', app: 'Teams', app_key: 'teams', mode: 'audio' });
  fs.copyFileSync(path.join(FIX, 'mikrofon.m4a'), path.join(m.dir, 'mikrofon.m4a'));
  execFileSync(ff.bin, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '19', '-c:a', 'aac', path.join(m.dir, 'sistem.m4a')]);
  m = lib.update(m.id, { status: 'processing', duration_sec: 19 });
  const media = await mix(m, { ff });
  m = lib.update(m.id, { media, status: 'ready' });
  const t = await transcribe(m, settings.all(), { ff });
  assert.equal(t.split_speakers, false);
  assert.ok(lib.transcript(m.id).segments.every(s => !s.speaker));
});
