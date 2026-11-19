'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../src/library');
const { sanitize } = require('../src/settings');
const { pickTitle } = require('../src/detector');
const { dueForArchive, moveDir } = require('../src/archive');

test('kütüphane: oluştur, güncelle, listele, güvenli yol', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutanak-lib-'));
  const archive = path.join(root, 'arsiv');
  const lib = new Library(() => ({ library: path.join(root, 'k'), archive }));
  const a = lib.create({ title: 'Bir', app_key: 'teams', mode: 'audio', started_at: '2026-11-03T11:05:00Z' });
  const b = lib.create({ title: 'İki', app_key: 'teams', mode: 'audio', started_at: '2026-11-03T11:05:00Z' });
  assert.notEqual(a.id, b.id);
  lib.update(a.id, { status: 'ready' });
  lib.setText(a.id, 'notlar.md', 'deneme notu');
  assert.equal(lib.list().length, 2);
  assert.ok(lib.searchText(a.id).includes('deneme notu'));
  assert.throws(() => lib.file(a.id, '../../etc/passwd'));
  assert.throws(() => lib.meta('../x'));
  moveDir(lib.dirOf(a.id), archive);
  assert.equal(lib.meta(a.id).status, 'ready', 'arşiv klasöründen de bulunur');
  assert.equal(lib.list().find(m => m.id === a.id).in_archive_dir, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ayarlar temizlenir', () => {
  assert.deepEqual(sanitize({ mode: 'kötü', ask: 'always', video_fps: 999, bilinmeyen: 1, apps: ['teams', 'teams'] }), { ask: 'always', video_fps: 60, apps: ['teams'] });
});

test('Teams pencere başlığından toplantı adı', () => {
  const windows = [
    { bundle: 'com.microsoft.teams2', title: 'Sohbet | Ahmet Yılmaz | Microsoft Teams' },
    { bundle: 'com.microsoft.teams2', title: 'Haftalık Sync | Microsoft Teams' },
    { bundle: 'com.apple.Safari', title: 'YouTube' },
  ];
  assert.equal(pickTitle('teams', windows), 'Haftalık Sync');
  assert.equal(pickTitle('teams', [{ bundle: 'com.microsoft.teams2', title: 'Microsoft Teams' }]), null);
});

test('otomatik arşiv yalnızca eski ve hazır toplantıları seçer', () => {
  const now = Date.parse('2026-11-30T00:00:00Z');
  const ms = [
    { id: 'a', status: 'ready', started_at: '2026-11-01T10:00:00Z' },
    { id: 'b', status: 'ready', started_at: '2026-11-29T10:00:00Z' },
    { id: 'c', status: 'archived', started_at: '2026-10-01T10:00:00Z' },
  ];
  assert.deepEqual(dueForArchive(ms, 14, now).map(m => m.id), ['a']);
  assert.deepEqual(dueForArchive(ms, 0, now), []);
});
