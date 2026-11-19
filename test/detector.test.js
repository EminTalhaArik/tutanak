'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Detector } = require('../src/detector');

test('Teams mikrofonu açınca başlar, ses bırakılınca bekleme sonrası biter', () => {
  const d = new Detector(() => ({ ask: 'ask', apps: ['teams'], end_grace_sec: 20 }));
  const events = [];
  d.on('start', e => events.push(['start', e.key]));
  d.on('end', e => events.push(['end', e.key]));
  const teams = (input, output) => [{ pid: 1, bundle: 'com.microsoft.teams2.modulehost', path: '', input, output }];
  let t = 0;
  d.procs = teams(true, true); d.evaluate(t);
  d.evaluate(t += 1000);
  assert.deepEqual(events, [], 'hemen başlamaz');
  d.evaluate(t += 2000);
  assert.deepEqual(events, [['start', 'teams']]);
  d.procs = teams(false, true); d.evaluate(t += 30000);   // sessize alındı ama görüşme sürüyor
  assert.equal(events.length, 1);
  d.procs = []; d.evaluate(t += 5000);
  assert.equal(events.length, 1, 'bekleme süresi dolmadı');
  d.evaluate(t += 21000);
  assert.deepEqual(events.at(-1), ['end', 'teams']);
  // izlenmeyen uygulama
  d.procs = [{ pid: 2, bundle: 'us.zoom.xos', path: '', input: true, output: true }];
  d.evaluate(t += 1000); d.evaluate(t += 5000);
  assert.equal(events.length, 2);
});
