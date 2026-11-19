'use strict';
// Arayüze ana süreçteki işlemleri açar (yalnızca izin verilen kanallar).
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['changed', 'level', 'shot', 'jobs', 'prompt', 'test-level'];

contextBridge.exposeInMainWorld('tutanak', {
  call: async (channel, ...args) => {
    const res = await ipcRenderer.invoke(channel, ...args);
    if (!res?.ok) {
      const err = new Error(res?.error || 'Bilinmeyen hata');
      err.kind = res?.kind;
      throw err;
    }
    return res.value;
  },
  on: (event, fn) => {
    if (!EVENTS.includes(event)) return () => {};
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
