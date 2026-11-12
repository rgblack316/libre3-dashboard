// Alert engine. Turns readings, poll results and the clock into one "active alert" plus beeps.
//
// Active alert (highest priority first):
//   urgent_low, urgent_high, low, high  glucose, only while data is fresh
//   no_data                             data is stale, or LibreLinkUp can't be reached/logged into
//
// Events:
//   'change' state   whenever anything the display shows changes
//   'beep'   { severity: 'urgent' | 'normal', key }   when a sound should play on the display

import { EventEmitter } from 'node:events';
import { inWindow } from './time.js';

const URGENT = new Set(['urgent_low', 'urgent_high']);
// Problems that won't fix themselves, so alert at once instead of waiting out the grace period.
const IMMEDIATE_API_CODES = new Set(['BAD_CREDENTIALS', 'NOT_CONFIGURED', 'LOGIN_FAILED', 'NO_CONNECTION']);
const API_GRACE_MS = 5 * 60_000;
const BOOT_GRACE_MS = 90_000; // don't raise "stale" before the first poll has had a chance

export class AlertEngine extends EventEmitter {
  constructor({ db, getSettings, now = Date.now }) {
    super();
    this.db = db;
    this.getSettings = getSettings;
    this.now = now;
    this.startedAt = now();

    this.level = null; // glucose level: urgent_low | low | high | urgent_high | null
    this.levelSince = null;
    this.lastValue = null;
    this.lastReadingTs = null;
    this.stale = false;
    this.apiFailure = null; // { code, message, since }
    this.apiActive = false;
    this.snoozedUntil = null;
    this.ackKey = null;
    this.activeKey = null;
    this.lastBeepAt = 0;
  }

  // ---- inputs -------------------------------------------------------------------------------

  onReading(reading) {
    this.lastReadingTs = reading.ts;
    this.lastValue = reading.value;
    this.#setLevel(this.#computeLevel(reading.value, this.level), reading.value);
    this.#reconcile();
  }

  onPollOk() {
    this.apiFailure = null;
    this.#reconcile();
  }

  onPollError(err) {
    const code = err?.code ?? 'ERROR';
    const message = err?.message ?? 'Unknown error';
    this.apiFailure = { code, message, since: this.apiFailure?.since ?? this.now() };
    this.#reconcile();
  }

  tick() {
    this.#reconcile();
  }

  onSettingsChanged() {
    if (this.lastValue !== null) this.#setLevel(this.#computeLevel(this.lastValue, this.level), this.lastValue);
    this.#reconcile(true);
  }

  // ---- user actions -------------------------------------------------------------------------

  snooze(minutes) {
    this.snoozedUntil = this.now() + minutes * 60_000;
    this.#reconcile(true);
  }

  clearSnooze() {
    this.snoozedUntil = null;
    this.#reconcile(true);
  }

  // Silences sound for the current alert only; a different alert (or a new one later) beeps again.
  acknowledge() {
    if (this.activeKey) this.ackKey = this.activeKey;
    this.#reconcile(true);
  }

  testBeep() {
    this.emit('beep', { severity: 'normal', key: 'test' });
  }

  getState() {
    const now = this.now();
    return {
      active: this.activeKey,
      level: this.level,
      levelSince: this.levelSince,
      stale: this.stale,
      apiError: this.apiActive && this.apiFailure ? { ...this.apiFailure } : null,
      snoozedUntil: this.snoozedUntil && now < this.snoozedUntil ? this.snoozedUntil : null,
      acknowledged: Boolean(this.activeKey && this.ackKey === this.activeKey),
    };
  }

  // ---- internals ----------------------------------------------------------------------------

  #computeLevel(value, prev) {
    const { thresholds: t, alerts: a } = this.getSettings();
    const h = a.hysteresis;
    let raw = null;
    if (value < t.urgentLow) raw = 'urgent_low';
    else if (value < t.low) raw = 'low';
    else if (value > t.urgentHigh) raw = 'urgent_high';
    else if (value > t.high) raw = 'high';

    // Hysteresis: stay in the previous alert until clearly back inside the range.
    if (prev === 'urgent_low' && raw !== 'urgent_low' && value < t.urgentLow + h) raw = 'urgent_low';
    else if ((prev === 'low' || prev === 'urgent_low') && raw === null && value < t.low + h) raw = 'low';
    else if (prev === 'urgent_high' && raw !== 'urgent_high' && value > t.urgentHigh - h) raw = 'urgent_high';
    else if ((prev === 'high' || prev === 'urgent_high') && raw === null && value > t.high - h) raw = 'high';

    // Disabled alert types fall back to the next milder one (urgent low off -> plain low, etc.).
    if (raw === 'urgent_low' && !a.urgentLow) raw = 'low';
    if (raw === 'low' && !a.low) raw = null;
    if (raw === 'urgent_high' && !a.urgentHigh) raw = 'high';
    if (raw === 'high' && !a.high) raw = null;
    return raw;
  }

  #setLevel(next, value) {
    if (next === this.level) return;
    const ts = this.now();
    if (this.level) this.db.logAlert({ ts, kind: 'glucose', level: this.level, value, event: 'end' });
    if (next) this.db.logAlert({ ts, kind: 'glucose', level: next, value, event: 'start' });
    this.level = next;
    this.levelSince = next ? ts : null;
  }

  #computeActive(s) {
    if (!this.stale && this.level) return this.level;
    if ((this.stale && s.alerts.stale) || (this.apiActive && s.alerts.apiError)) return 'no_data';
    return null;
  }

  #soundAllowed(sev, s, now) {
    const a = s.alerts;
    if (!a.sound) return false;
    if (this.ackKey === this.activeKey) return false;
    const snoozed = this.snoozedUntil && now < this.snoozedUntil;
    if (snoozed && !(sev === 'urgent' && !a.snoozeUrgent)) return false;
    if (sev !== 'urgent' && a.quietHours.enabled && inWindow(now, a.quietHours.start, a.quietHours.end, s.system.timezone)) {
      return false;
    }
    return true;
  }

  #reconcile(force = false) {
    const now = this.now();
    const s = this.getSettings();
    let changed = force;

    // Stale data
    const ref = this.lastReadingTs ?? this.db.latest()?.ts ?? null;
    const staleNow = now - this.startedAt > BOOT_GRACE_MS && (ref === null || now - ref > s.stale.minutes * 60_000);
    if (staleNow !== this.stale) {
      this.stale = staleNow;
      this.db.logAlert({ ts: now, kind: 'stale', event: staleNow ? 'start' : 'end' });
      changed = true;
    }

    // LibreLinkUp unreachable / login failing
    const apiNow = Boolean(
      this.apiFailure && (IMMEDIATE_API_CODES.has(this.apiFailure.code) || now - this.apiFailure.since >= API_GRACE_MS),
    );
    if (apiNow !== this.apiActive) {
      this.apiActive = apiNow;
      this.db.logAlert({ ts: now, kind: 'api', level: this.apiFailure?.code ?? null, event: apiNow ? 'start' : 'end' });
      changed = true;
    }

    // Snooze expiry
    if (this.snoozedUntil && now >= this.snoozedUntil) {
      this.snoozedUntil = null;
      changed = true;
    }

    // The active alert changed: beep right away and forget any acknowledgement of the old one.
    const key = this.#computeActive(s);
    if (key !== this.activeKey) {
      this.activeKey = key;
      this.lastBeepAt = 0;
      if (this.ackKey !== key) this.ackKey = null;
      changed = true;
    }

    if (key) {
      const sev = URGENT.has(key) ? 'urgent' : 'normal';
      const everyMs = (sev === 'urgent' ? s.alerts.urgentRepeatMinutes : s.alerts.repeatMinutes) * 60_000;
      if (this.#soundAllowed(sev, s, now) && now - this.lastBeepAt >= everyMs) {
        this.lastBeepAt = now;
        this.emit('beep', { severity: sev, key });
      }
    }

    if (changed) this.emit('change', this.getState());
  }
}
