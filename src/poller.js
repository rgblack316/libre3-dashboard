// Polls LibreLinkUp on a fixed interval, stores readings, and emits events for later features
// (live display updates, alert engine).
//
// Events:
//   'poll'      { ok: true, inserted, current }   after every successful poll
//   'reading'   current reading object            only when a NEW current reading arrives
//   'pollError' LibreError                        after every failed poll

import { EventEmitter } from 'node:events';

const BAD_CREDENTIALS_DELAY_MS = 30 * 60_000; // retrying a wrong password quickly risks locking the account
const RATE_LIMIT_MIN_DELAY_MS = 5 * 60_000;

export class Poller extends EventEmitter {
  constructor({ client, db, intervalMs = 60_000, maxBackoffMs = 10 * 60_000 }) {
    super();
    this.client = client;
    this.db = db;
    this.intervalMs = intervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.failures = 0;
    this.lastError = null;
    this.lastReadingTs = null;
    this.running = false;
    this.timer = null;
  }

  async pollOnce() {
    try {
      const { current, history } = await this.client.read();
      const rows = current ? [...history, current] : history;
      const inserted = this.db.insertReadings(rows);
      this.failures = 0;
      this.lastError = null;
      this.db.setState('last_poll', JSON.stringify({ at: Date.now(), ok: true, inserted }));
      const result = { ok: true, inserted, current };
      this.emit('poll', result);
      if (current && current.ts !== this.lastReadingTs) {
        this.lastReadingTs = current.ts;
        this.emit('reading', current);
      }
      return result;
    } catch (err) {
      this.failures += 1;
      this.lastError = err;
      this.db.setState(
        'last_poll',
        JSON.stringify({ at: Date.now(), ok: false, code: err.code ?? 'ERROR', message: err.message }),
      );
      this.emit('pollError', err);
      return { ok: false, error: err };
    }
  }

  nextDelay() {
    if (this.failures === 0) return this.intervalMs;
    if (this.lastError?.code === 'BAD_CREDENTIALS') return BAD_CREDENTIALS_DELAY_MS;
    let delay = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 6), this.maxBackoffMs);
    if (this.lastError?.code === 'RATE_LIMIT') delay = Math.max(delay, RATE_LIMIT_MIN_DELAY_MS);
    return delay;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.pollOnce(); // never throws
      if (!this.running) return;
      this.timer = setTimeout(loop, this.nextDelay());
    };
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
