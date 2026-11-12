import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { createSettingsStore } from '../src/settings.js';
import { AlertEngine } from '../src/alerts.js';
import { LibreError } from '../src/libre.js';

const MIN = 60_000;

function setup({ overrides, start = Date.UTC(2026, 10, 12, 12, 0, 0) } = {}) {
  const db = openDb(':memory:');
  const settings = createSettingsStore(db);
  if (overrides) {
    const r = settings.update(overrides);
    assert.ok(r.ok, JSON.stringify(r.errors));
  }
  let t = start;
  const engine = new AlertEngine({ db, getSettings: settings.get, now: () => t });
  const beeps = [];
  engine.on('beep', (b) => beeps.push(b));
  const advance = (ms) => {
    t += ms;
  };
  const reading = (value) => engine.onReading({ ts: t, value, trend: 3, isHigh: false, isLow: false });
  return { db, settings, engine, beeps, advance, reading, now: () => t };
}

test('glucose levels follow the thresholds', () => {
  const { engine, reading } = setup();
  reading(120);
  assert.equal(engine.getState().active, null);
  reading(65);
  assert.equal(engine.getState().active, 'low');
  reading(50);
  assert.equal(engine.getState().active, 'urgent_low');
  reading(200);
  assert.equal(engine.getState().active, 'high');
  reading(70); // exactly at the low threshold is not low
  assert.equal(engine.getState().active, null);
  reading(180); // exactly at the high threshold is not high
  assert.equal(engine.getState().active, null);
});

test('urgent high is optional and falls back to high when off', () => {
  const off = setup();
  off.reading(300);
  assert.equal(off.engine.getState().active, 'high');

  const on = setup({ overrides: { alerts: { urgentHigh: true } } });
  on.reading(300);
  assert.equal(on.engine.getState().active, 'urgent_high');
});

test('disabled alert types: urgent low off -> plain low; both off -> nothing', () => {
  const a = setup({ overrides: { alerts: { urgentLow: false } } });
  a.reading(50);
  assert.equal(a.engine.getState().active, 'low');

  const b = setup({ overrides: { alerts: { urgentLow: false, low: false } } });
  b.reading(50);
  assert.equal(b.engine.getState().active, null);

  const c = setup({ overrides: { alerts: { low: false } } }); // low off, urgent low still on
  c.reading(60);
  assert.equal(c.engine.getState().active, null);
  c.reading(50);
  assert.equal(c.engine.getState().active, 'urgent_low');
});

test('hysteresis keeps an alert until the reading is clearly back in range', () => {
  const { engine, reading } = setup(); // margin 5: low clears at 75, high clears at 175
  reading(65);
  reading(72);
  assert.equal(engine.getState().active, 'low');
  reading(75);
  assert.equal(engine.getState().active, null);

  reading(190);
  reading(177);
  assert.equal(engine.getState().active, 'high');
  reading(175);
  assert.equal(engine.getState().active, null);

  reading(50);
  reading(57); // still inside the urgent-low margin
  assert.equal(engine.getState().active, 'urgent_low');
  reading(62); // out of urgent low, still below 70
  assert.equal(engine.getState().active, 'low');
});

test('beeps immediately, then repeats on the configured interval', () => {
  const { engine, beeps, advance, reading } = setup();
  reading(65);
  assert.equal(beeps.length, 1);
  assert.deepEqual(beeps[0], { severity: 'normal', key: 'low' });

  advance(4 * MIN);
  engine.tick();
  assert.equal(beeps.length, 1);
  advance(1 * MIN);
  engine.tick();
  assert.equal(beeps.length, 2); // 5 min repeat

  reading(50); // escalation beeps at once, as urgent
  assert.equal(beeps.length, 3);
  assert.equal(beeps[2].severity, 'urgent');
  advance(2 * MIN);
  engine.tick();
  assert.equal(beeps.length, 4); // urgent repeats every 2 min

  reading(120); // back in range: no more beeps
  advance(10 * MIN);
  engine.tick();
  assert.equal(beeps.length, 4);
});

test('sound off setting silences beeps but the alert stays active', () => {
  const { engine, beeps, reading } = setup({ overrides: { alerts: { sound: false } } });
  reading(50);
  assert.equal(beeps.length, 0);
  assert.equal(engine.getState().active, 'urgent_low');
});

test('snooze mutes normal alerts but not urgent ones, unless configured', () => {
  const a = setup();
  a.engine.snooze(30);
  a.reading(65);
  assert.equal(a.beeps.length, 0);
  assert.ok(a.engine.getState().snoozedUntil);
  a.reading(50); // urgent low breaks through
  assert.equal(a.beeps.length, 1);

  const b = setup({ overrides: { alerts: { snoozeUrgent: true } } });
  b.engine.snooze(30);
  b.reading(50);
  assert.equal(b.beeps.length, 0);
});

test('snooze expires, state updates, and beeping resumes', () => {
  const { engine, beeps, advance, reading } = setup();
  const states = [];
  engine.on('change', (s) => states.push(s));
  reading(65);
  engine.snooze(10);
  assert.equal(beeps.length, 1);
  advance(10 * MIN);
  engine.tick();
  assert.equal(engine.getState().snoozedUntil, null);
  assert.equal(beeps.length, 2); // snooze over and the repeat interval has passed
  engine.clearSnooze();
  assert.ok(states.length >= 2);
});

test('acknowledge silences only the current alert', () => {
  const { engine, beeps, advance, reading } = setup();
  reading(65);
  assert.equal(beeps.length, 1);
  engine.acknowledge();
  assert.equal(engine.getState().acknowledged, true);
  advance(10 * MIN);
  engine.tick();
  assert.equal(beeps.length, 1); // still silent

  reading(50); // escalation is a different alert: sounds again
  assert.equal(engine.getState().acknowledged, false);
  assert.equal(beeps.length, 2);

  reading(120);
  reading(65); // a fresh low later also sounds
  assert.equal(beeps.length, 3);
});

test('quiet hours mute non-urgent sound only', () => {
  const night = Date.UTC(2026, 10, 12, 23, 30, 0);
  const overrides = { alerts: { quietHours: { enabled: true, start: '22:00', end: '07:00' } }, system: { timezone: 'UTC' } };

  const a = setup({ overrides, start: night });
  a.reading(65);
  assert.equal(a.beeps.length, 0);
  assert.equal(a.engine.getState().active, 'low'); // still shown
  a.reading(50);
  assert.equal(a.beeps.length, 1); // urgent still sounds

  const day = setup({ overrides, start: Date.UTC(2026, 10, 12, 12, 0, 0) });
  day.reading(65);
  assert.equal(day.beeps.length, 1);
});

test('no data: stale readings raise an alert after a boot grace period, and clear on a new reading', () => {
  const { engine, advance, reading, beeps } = setup();
  reading(65);
  advance(11 * MIN); // reading is 11 min old (limit 10), and boot grace has passed
  engine.tick();
  const s = engine.getState();
  assert.equal(s.stale, true);
  assert.equal(s.active, 'no_data'); // a stale low is not trusted as a current low
  assert.ok(beeps.some((b) => b.key === 'no_data'));

  reading(100);
  assert.equal(engine.getState().stale, false);
  assert.equal(engine.getState().active, null);
});

test('no data: no false alarm right after startup; can be turned off', () => {
  const a = setup();
  a.engine.tick();
  assert.equal(a.engine.getState().stale, false); // within boot grace, nothing read yet

  const b = setup({ overrides: { alerts: { stale: false } } });
  b.advance(30 * MIN);
  b.engine.tick();
  assert.equal(b.engine.getState().stale, true);
  assert.equal(b.engine.getState().active, null);
});

test('API problems: network errors wait 5 minutes; login failures alert at once', () => {
  const net = setup();
  net.reading(100);
  net.engine.onPollError(new LibreError('offline', { code: 'NETWORK' }));
  assert.equal(net.engine.getState().active, null);
  net.advance(5 * MIN);
  net.engine.onPollError(new LibreError('offline', { code: 'NETWORK' }));
  assert.equal(net.engine.getState().active, 'no_data');
  assert.equal(net.engine.getState().apiError.code, 'NETWORK');
  net.engine.onPollOk();
  assert.equal(net.engine.getState().apiError, null);

  const login = setup();
  login.engine.onPollError(new LibreError('bad', { code: 'BAD_CREDENTIALS' }));
  assert.equal(login.engine.getState().active, 'no_data');
  assert.equal(login.engine.getState().apiError.code, 'BAD_CREDENTIALS');

  const none = setup();
  none.engine.onPollError(new LibreError('none', { code: 'NOT_CONFIGURED' }));
  assert.equal(none.engine.getState().apiError.code, 'NOT_CONFIGURED');
});

test('changing thresholds re-evaluates the current reading', () => {
  const { engine, settings, reading } = setup();
  reading(75);
  assert.equal(engine.getState().active, null);
  settings.update({ thresholds: { low: 80 } });
  engine.onSettingsChanged();
  assert.equal(engine.getState().active, 'low');
});

test('alerts are logged with start and end events', () => {
  const { db, advance, reading, engine } = setup();
  reading(65);
  advance(MIN);
  reading(120);
  engine.onPollError(new LibreError('x', { code: 'BAD_CREDENTIALS' }));
  const log = db.recentAlerts(10).reverse();
  assert.deepEqual(
    log.map((r) => `${r.kind}:${r.level}:${r.event}`),
    ['glucose:low:start', 'glucose:low:end', 'api:BAD_CREDENTIALS:start'],
  );
  assert.equal(log[0].value, 65);
});
