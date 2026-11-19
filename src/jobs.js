'use strict';
/**
 * Ağır işler (birleştirme, döküm, arşivleme) sırayla tek tek çalışır; arayüz ilerlemeyi izler.
 */
const { EventEmitter } = require('node:events');

class Jobs extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
  }

  /** Aynı toplantı için aynı türde bekleyen iş varsa yenisi eklenmez */
  add({ id, kind, label, run }) {
    const dup = [this.current, ...this.queue].find(j => j && j.id === id && j.kind === kind);
    if (dup) return dup.promise;
    const job = { id, kind, label, run, step: label, pct: 0 };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {}); // bekleyen yoksa işlenmemiş ret sayılmasın; hata 'failed' olayıyla da bildirilir
    this.queue.push(job);
    this.emit('change', this.status());
    setImmediate(() => this.next());
    return job.promise;
  }

  async next() {
    if (this.current || !this.queue.length) return;
    const job = (this.current = this.queue.shift());
    this.emit('change', this.status());
    let lastEmit = 0;
    const progress = (step, pct) => {
      job.step = step || job.step;
      job.pct = Math.max(0, Math.min(1, Number(pct) || 0));
      const now = Date.now();
      if (now - lastEmit > 250 || job.pct >= 1) {
        lastEmit = now;
        this.emit('change', this.status());
      }
    };
    try {
      job.resolve(await job.run(progress));
    } catch (e) {
      console.error(`Tutanak işi (${job.kind} ${job.id}):`, e.message);
      this.emit('failed', { id: job.id, kind: job.kind, error: e.message });
      job.reject(e);
    } finally {
      this.current = null;
      this.emit('change', this.status());
      this.emit('done', { id: job.id, kind: job.kind });
      setImmediate(() => this.next());
    }
  }

  status() {
    const brief = j => ({ id: j.id, kind: j.kind, label: j.label, step: j.step, pct: j.pct });
    return { current: this.current ? brief(this.current) : null, queued: this.queue.map(brief) };
  }

  busy(id) {
    return [this.current, ...this.queue].some(j => j && j.id === id);
  }
}

module.exports = { Jobs };
