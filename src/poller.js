// Polls LibreLinkUp on a fixed interval, stores readings, and emits events for the alert engine
// and the live display.
//
// Events:
//   'reading'   current reading object            only when a NEW current reading arrives
//   'poll'      { ok: true, inserted, current }   after every successful poll
//   'pollError' LibreError                        after every failed poll

import { EventEmitter } from 'node:events';
import { LibreError } from './libre.js';

const BAD_CREDENTIALS_DELAY_MS = 30 * 60_000; // retrying a wrong password quickly risks locking the account
const RATE_LIMIT_MIN_DELAY_MS = 5 * 60_000;
const NOT_CONFIGURED_DELAY_MS = 30_000;

export class Poller extends EventEmitter {
  constructor({ client = null, db, intervalMs = 60_000, maxBackoffMs = 10 * 60_000 }) {
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
    this.inflight = null;
  }

  // Swap in a client for new credentials (or null when no account is configured).
  setClient(client) {
    this.client = client;
    this.failures = 0;
    this.lastError = null;
  }

  setIntervalMs(ms) {
    this.intervalMs = ms;
  }

  pollOnce() {
    if (!this.inflight) this.inflight = this.#poll().finally(() => (this.inflight = null));
    return this.inflight;
  }

  async #poll() {
    try {
      if (!this.client) throw new LibreError('No LibreLinkUp account configured', { code: 'NOT_CONFIGURED' });
      const { current, history } = await this.client.read();
      const rows = current ? [...history, current] : history;
      const inserted = this.db.insertReadings(rows);
      this.failures = 0;
      this.lastError = null;
      this.db.setState('last_poll', JSON.stringify({ at: Date.now(), ok: true, inserted }));
      const result = { ok: true, inserted, current };
      if (current && current.ts !== this.lastReadingTs) {
        this.lastReadingTs = current.ts;
        this.emit('reading', current);
      }
      this.emit('poll', result);
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
    if (this.lastError?.code === 'NOT_CONFIGURED') return NOT_CONFIGURED_DELAY_MS;
    let delay = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 6), this.maxBackoffMs);
    if (this.lastError?.code === 'RATE_LIMIT') delay = Math.max(delay, RATE_LIMIT_MIN_DELAY_MS);
    return delay;
  }

  #schedule(delay) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#cycle(), delay);
    this.timer.unref?.();
  }

  async #cycle() {
    if (!this.running) return;
    await this.pollOnce(); // never throws
    this.#schedule(this.nextDelay());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#cycle();
  }

  // Poll right now and restart the countdown (used after the account or interval changes).
  async pollNow() {
    if (!this.running) return this.pollOnce();
    clearTimeout(this.timer);
    return this.#cycle();
  }

  // Stops scheduling and waits for any poll already in flight, so the database can be closed safely.
  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    try {
      await this.inflight;
    } catch {
      /* the poll reports its own errors */
    }
  }
}
