import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { DEFAULT_SETTINGS, createSettingsStore, validate, mergeInto } from '../src/settings.js';
import { computeStats, downsample } from '../src/stats.js';
import { createAuth, generatePassword, hashPassword, verifyPassword } from '../src/auth.js';
import { createCredentialStore } from '../src/creds.js';
import { inWindow, isValidTimeZone } from '../src/time.js';
import { randomBytes } from 'node:crypto';

// ---- settings ---------------------------------------------------------------------------------

test('default settings are valid', () => {
  assert.deepEqual(validate(structuredClone(DEFAULT_SETTINGS)), []);
});

test('settings: partial updates merge, persist, and are frozen', () => {
  const db = openDb(':memory:');
  const store = createSettingsStore(db);
  const r = store.update({ thresholds: { low: 80 }, alerts: { quietHours: { enabled: true } } });
  assert.equal(r.ok, true);
  assert.equal(store.get().thresholds.low, 80);
  assert.equal(store.get().thresholds.high, 180); // untouched
  assert.equal(store.get().alerts.quietHours.start, '22:00'); // untouched nested default
  assert.throws(() => {
    store.get().thresholds.low = 1;
  }, TypeError);

  // A new store on the same database sees the saved values.
  assert.equal(createSettingsStore(db).get().thresholds.low, 80);
  db.close();
});

test('settings: invalid input is rejected whole, with field names', () => {
  const db = openDb(':memory:');
  const store = createSettingsStore(db);
  const before = JSON.stringify(store.get());

  const order = store.update({ thresholds: { low: 200 } }); // low >= high
  assert.equal(order.ok, false);
  assert.ok(order.errors.some((e) => e.field === 'thresholds.low'));

  const types = store.update({ thresholds: { high: 'lots' }, alerts: { sound: 'yes' } });
  assert.equal(types.ok, false);
  assert.deepEqual(types.errors.map((e) => e.field).sort(), ['alerts.sound', 'thresholds.high']);

  assert.equal(store.update({ display: { chartHours: 5 } }).ok, false);
  assert.equal(store.update({ system: { pollSeconds: 5 } }).ok, false);
  assert.equal(store.update({ system: { timezone: 'Mars/Olympus' } }).ok, false);
  assert.equal(store.update({ alerts: { quietHours: { enabled: true, start: '22:00', end: '22:00' } } }).ok, false);
  assert.equal(store.update({ alerts: { quietHours: { start: '25:00' } } }).ok, false);

  assert.equal(JSON.stringify(store.get()), before); // nothing leaked through
  db.close();
});

test('settings: unknown keys are ignored and corrupt stored JSON falls back to defaults', () => {
  const merged = mergeInto(structuredClone(DEFAULT_SETTINGS), { nope: 1, thresholds: { evil: 2 } }, []);
  assert.equal('nope' in merged, false);
  assert.equal('evil' in merged.thresholds, false);

  const db = openDb(':memory:');
  db.setState('settings', '{not json');
  assert.deepEqual(createSettingsStore(db).get(), DEFAULT_SETTINGS);
  db.close();
});

test('time zones and quiet-hour windows (including across midnight)', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Nope/Nowhere'), false);
  const at = (h, m = 0) => Date.UTC(2026, 10, 12, h, m);
  assert.equal(inWindow(at(23), '22:00', '07:00', 'UTC'), true);
  assert.equal(inWindow(at(3), '22:00', '07:00', 'UTC'), true);
  assert.equal(inWindow(at(12), '22:00', '07:00', 'UTC'), false);
  assert.equal(inWindow(at(7), '22:00', '07:00', 'UTC'), false); // end is exclusive
  assert.equal(inWindow(at(22), '22:00', '07:00', 'UTC'), true); // start is inclusive
  assert.equal(inWindow(at(12), '09:00', '17:00', 'UTC'), true);
  // 03:00 UTC on Nov 12 is 22:00 the previous evening in New York (EST, UTC-5)
  assert.equal(inWindow(at(3), '22:00', '07:00', 'America/New_York'), true);
  assert.equal(inWindow(at(12), '22:00', '07:00', 'America/New_York'), false);
});

// ---- stats ------------------------------------------------------------------------------------

test('stats are time-weighted, not per-reading', () => {
  const min = 60_000;
  const rows = [
    { ts: 0, value: 100 },
    { ts: 10 * min, value: 200 },
  ];
  const s = computeStats(rows, { low: 70, high: 180, now: 11 * min, rangeMs: 24 * 60 * min });
  // 100 held for 10 min, 200 held for 1 min => (1000 + 200) / 11
  assert.equal(s.avg, 109);
  assert.equal(s.min, 100);
  assert.equal(s.max, 200);
  assert.equal(s.count, 2);
  assert.equal(s.tir.above, 9.1);
  assert.equal(s.tir.below, 0);
  assert.equal(s.tir.inRange, 90.9);
  assert.equal(s.gmi, 5.9);
  assert.ok(s.coverage > 0 && s.coverage < 1);
});

test('stats: a long gap does not count as time in range; empty input gives null', () => {
  const min = 60_000;
  const rows = [
    { ts: 0, value: 100 },
    { ts: 120 * min, value: 100 }, // 2 hours later
  ];
  const s = computeStats(rows, { low: 70, high: 180, now: 121 * min, rangeMs: 200 * min });
  // Each reading covers at most 20 min (+1 min for the last): coverage well under the 2h gap
  assert.ok(s.coverage < 0.25);
  assert.equal(computeStats([], { low: 70, high: 180, now: 0 }), null);
});

test('downsample averages into buckets and keeps order', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ ts: i * 60_000, value: 100 + (i % 10), trend: i === 999 ? 4 : null }));
  const out = downsample(rows, 100);
  assert.ok(out.length <= 100 && out.length >= 90);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].ts > out[i - 1].ts);
  assert.equal(out.at(-1).trend, 4);
  assert.equal(downsample(rows.slice(0, 50), 100).length, 50); // small input untouched
});

// ---- auth -------------------------------------------------------------------------------------

test('password hashing verifies and rejects', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.notEqual(await hashPassword('correct horse'), h); // salted
  const pw = generatePassword();
  assert.match(pw, /^[A-Za-z0-9]{16}$/);
});

test('auth: first start seeds from env or generates; never overwrites', async () => {
  const db = openDb(':memory:');
  const auth = createAuth(db);
  const first = await auth.init('seed-password');
  assert.equal(first.generated, null);
  assert.equal(await auth.verify('seed-password'), true);
  assert.equal((await auth.init('different')).generated, null); // already set: ignored
  assert.equal(await auth.verify('different'), false);

  const db2 = openDb(':memory:');
  const auth2 = createAuth(db2);
  const gen = await auth2.init('');
  assert.match(gen.generated, /^[A-Za-z0-9]{16}$/);
  assert.equal(await auth2.verify(gen.generated), true);

  await auth2.setPassword('brand-new-pass');
  assert.equal(await auth2.verify('brand-new-pass'), true);
  assert.equal(await auth2.verify(gen.generated), false);
  db.close();
  db2.close();
});

test('auth: sessions expire; throttle locks after 5 failures and recovers', () => {
  let t = 1_000_000;
  const auth = createAuth(openDb(':memory:'), { now: () => t });
  const token = auth.sessions.create();
  assert.equal(auth.sessions.valid(token), true);
  assert.equal(auth.sessions.valid('nope'), false);
  const other = auth.sessions.create();
  auth.sessions.destroyAllExcept(token);
  assert.equal(auth.sessions.valid(other), false);
  assert.equal(auth.sessions.valid(token), true);
  t += 13 * 3600_000;
  assert.equal(auth.sessions.valid(token), false);

  for (let i = 0; i < 4; i++) auth.throttle.fail('1.2.3.4');
  assert.equal(auth.throttle.check('1.2.3.4').allowed, true);
  auth.throttle.fail('1.2.3.4');
  assert.equal(auth.throttle.check('1.2.3.4').allowed, false);
  assert.equal(auth.throttle.check('9.9.9.9').allowed, true); // other clients unaffected
  t += 61_000;
  assert.equal(auth.throttle.check('1.2.3.4').allowed, true);
  auth.throttle.fail('1.2.3.4'); // 6th failure: lock doubles to 2 min
  assert.ok(auth.throttle.check('1.2.3.4').retryAfterMs > 60_000);
  auth.throttle.success('1.2.3.4');
  assert.equal(auth.throttle.check('1.2.3.4').allowed, true);
});

// ---- credential store -------------------------------------------------------------------------

test('stored LibreLinkUp password is encrypted and unreadable without the key', () => {
  const db = openDb(':memory:');
  const key = randomBytes(32);
  const store = createCredentialStore(db, key);
  assert.equal(store.get(), null);
  store.set({ email: 'a@b.co', password: 'hunter2-secret', region: 'eu' });
  assert.deepEqual(store.get(), { email: 'a@b.co', password: 'hunter2-secret', region: 'eu' });
  assert.equal(db.getState('llu_creds').includes('hunter2-secret'), false);
  assert.equal(createCredentialStore(db, randomBytes(32)).get(), null); // wrong key
  db.close();
});
