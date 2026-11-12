import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { LibreLinkUpClient, LibreError, normalizeMeasurement, parseLibreTimestamp } from '../src/libre.js';
import { openDb } from '../src/db.js';
import { Poller } from '../src/poller.js';
import { startMock, formatLibreTimestamp } from './mock-llu.js';

const makeClient = (mock, extra = {}) =>
  new LibreLinkUpClient({
    email: mock.email,
    password: mock.password,
    baseUrl: mock.regionUrl,
    ...extra,
  });

test('parseLibreTimestamp handles 12-hour edge cases as UTC', () => {
  assert.equal(parseLibreTimestamp('11/12/2026 12:00:00 AM'), Date.UTC(2026, 10, 12, 0, 0, 0));
  assert.equal(parseLibreTimestamp('11/12/2026 12:30:00 PM'), Date.UTC(2026, 10, 12, 12, 30, 0));
  assert.equal(parseLibreTimestamp('11/12/2026 5:20:15 PM'), Date.UTC(2026, 10, 12, 17, 20, 15));
  assert.equal(parseLibreTimestamp('1/2/2026 9:05:00 AM'), Date.UTC(2026, 0, 2, 9, 5, 0));
  assert.equal(parseLibreTimestamp('garbage'), null);
  assert.equal(parseLibreTimestamp(undefined), null);
  // Round trip with the mock's formatter.
  const t = Date.UTC(2026, 10, 12, 23, 59, 1);
  assert.equal(parseLibreTimestamp(formatLibreTimestamp(t)), t);
});

test('normalizeMeasurement trusts only mg/dL values and FactoryTimestamp', () => {
  const ok = normalizeMeasurement(
    { FactoryTimestamp: '11/12/2026 5:20:00 PM', ValueInMgPerDl: 112.4, TrendArrow: 4, isHigh: false, isLow: false },
    { withTrend: true },
  );
  assert.deepEqual(ok, { ts: Date.UTC(2026, 10, 12, 17, 20, 0), value: 112, trend: 4, isHigh: false, isLow: false });
  // History points carry no trend even if one were present.
  assert.equal(normalizeMeasurement({ FactoryTimestamp: '11/12/2026 5:20:00 PM', ValueInMgPerDl: 100, TrendArrow: 3 }).trend, null);
  // mmol/L-only or timestamp-less data is skipped rather than guessed.
  assert.equal(normalizeMeasurement({ FactoryTimestamp: '11/12/2026 5:20:00 PM', Value: 6.2 }), null);
  assert.equal(normalizeMeasurement({ Timestamp: '11/12/2026 5:20:00 PM', ValueInMgPerDl: 100 }), null);
  assert.equal(normalizeMeasurement({ FactoryTimestamp: '11/12/2026 5:20:00 PM', ValueInMgPerDl: 100, TrendArrow: 9 }, { withTrend: true }).trend, null);
});

test('login follows the region redirect and sends the expected headers', async () => {
  const mock = await startMock({ redirectRegion: 'us' });
  try {
    let regionSeen = null;
    const client = new LibreLinkUpClient({
      email: mock.email,
      password: mock.password,
      baseUrl: mock.url,
      regionBaseUrl: (r) => {
        regionSeen = r;
        return mock.regionUrl;
      },
    });
    const { current, history, patientId } = await client.read();

    assert.equal(regionSeen, 'us');
    assert.equal(client.baseUrl, mock.regionUrl);
    assert.equal(mock.state.loginCalls, 2); // global host, then regional host
    assert.equal(mock.state.loginHeaders.product, 'llu.android');
    assert.ok(mock.state.loginHeaders.version);
    assert.equal(
      mock.state.lastAuthHeaders['account-id'],
      createHash('sha256').update(mock.userId).digest('hex'),
    );
    assert.equal(patientId, 'patient-1');
    assert.equal(history.length, 12);
    assert.equal(current.value, 112);
    assert.equal(current.trend, 4);
    // Uses the UTC FactoryTimestamp, not the zone-less local Timestamp.
    assert.equal(current.ts, Date.UTC(2026, 10, 12, 17, 20, 0));
  } finally {
    await mock.close();
  }
});

test('poller stores readings and de-duplicates repeated polls', async () => {
  const mock = await startMock();
  const db = openDb(':memory:');
  try {
    const poller = new Poller({ client: makeClient(mock), db });
    const events = [];
    poller.on('reading', (r) => events.push(r));

    const first = await poller.pollOnce();
    assert.equal(first.ok, true);
    assert.equal(first.inserted, 13); // 12 history + current
    assert.equal(db.count(), 13);
    assert.equal(db.latest().value, 112);
    assert.equal(db.latest().trend, 4);

    // Same data again: nothing new, no new 'reading' event.
    const second = await poller.pollOnce();
    assert.equal(second.inserted, 0);
    assert.equal(db.count(), 13);
    assert.equal(events.length, 1);

    // A minute later: exactly one new row and one new event.
    mock.state.now += 60_000;
    mock.state.value = 118;
    mock.state.trendArrow = 5;
    const third = await poller.pollOnce();
    assert.equal(third.inserted, 1);
    assert.equal(db.count(), 14);
    assert.equal(db.latest().value, 118);
    assert.equal(db.latest().trend, 5);
    assert.equal(events.length, 2);
    // 17:00-18:00 UTC holds 4 history points (17:00, :05, :10, :15) plus the 17:20 and 17:21 readings.
    assert.equal(db.range(Date.UTC(2026, 10, 12, 17, 0, 0), Date.UTC(2026, 10, 12, 18, 0, 0)).length, 6);

    assert.equal(JSON.parse(db.getState('last_poll')).ok, true);
  } finally {
    db.close();
    await mock.close();
  }
});

test('a trend-less history point is later enriched, never erased, by the current reading', () => {
  const db = openDb(':memory:');
  const ts = Date.UTC(2026, 10, 12, 17, 20, 0);
  db.insertReadings([{ ts, value: 110, trend: null, isHigh: false, isLow: false }]);
  db.insertReadings([{ ts, value: 110, trend: 3, isHigh: false, isLow: false }]);
  assert.equal(db.latest().trend, 3);
  db.insertReadings([{ ts, value: 110, trend: null, isHigh: false, isLow: false }]);
  assert.equal(db.latest().trend, 3);
  assert.equal(db.count(), 1);
  db.close();
});

test('an expired session (401) triggers one re-login and the poll still succeeds', async () => {
  const mock = await startMock();
  const db = openDb(':memory:');
  try {
    const poller = new Poller({ client: makeClient(mock), db });
    assert.equal((await poller.pollOnce()).ok, true);
    assert.equal(mock.state.loginCalls, 1);

    mock.state.expireNext = true;
    mock.state.now += 60_000;
    const result = await poller.pollOnce();
    assert.equal(result.ok, true);
    assert.equal(mock.state.loginCalls, 2);
    assert.equal(result.inserted, 1);
  } finally {
    db.close();
    await mock.close();
  }
});

test('bad credentials fail cleanly, store nothing, and back off for 30 minutes', async () => {
  const mock = await startMock();
  const db = openDb(':memory:');
  try {
    const client = new LibreLinkUpClient({ email: mock.email, password: 'wrong', baseUrl: mock.regionUrl });
    const poller = new Poller({ client, db, intervalMs: 60_000 });
    let emitted = null;
    poller.on('pollError', (e) => (emitted = e));

    const result = await poller.pollOnce();
    assert.equal(result.ok, false);
    assert.ok(emitted instanceof LibreError);
    assert.equal(emitted.code, 'BAD_CREDENTIALS');
    assert.equal(db.count(), 0);
    assert.equal(poller.nextDelay(), 30 * 60_000);
    assert.equal(JSON.parse(db.getState('last_poll')).code, 'BAD_CREDENTIALS');
  } finally {
    db.close();
    await mock.close();
  }
});

test('network failures back off exponentially up to the cap, then recover', async () => {
  const db = openDb(':memory:');
  const client = new LibreLinkUpClient({
    email: 'a@b.c',
    password: 'x',
    baseUrl: 'http://127.0.0.1:1', // nothing listens here
    timeoutMs: 1000,
  });
  const poller = new Poller({ client, db, intervalMs: 60_000, maxBackoffMs: 600_000 });

  assert.equal(poller.nextDelay(), 60_000);
  await poller.pollOnce();
  assert.equal(poller.lastError.code, 'NETWORK');
  assert.equal(poller.nextDelay(), 120_000);
  poller.failures = 3;
  assert.equal(poller.nextDelay(), 480_000);
  poller.failures = 10;
  assert.equal(poller.nextDelay(), 600_000);

  poller.lastError = new LibreError('slow down', { code: 'RATE_LIMIT' });
  poller.failures = 1;
  assert.equal(poller.nextDelay(), 300_000); // never sooner than 5 minutes after a rate limit
  db.close();
});

test('poller loop runs on schedule and stops cleanly', async () => {
  const mock = await startMock();
  const db = openDb(':memory:');
  try {
    const poller = new Poller({ client: makeClient(mock), db, intervalMs: 50 });
    await new Promise((resolve) => {
      let polls = 0;
      poller.on('poll', () => {
        polls += 1;
        if (polls === 3) resolve();
      });
      poller.start();
    });
    poller.stop();
    const calls = mock.state.graphCalls;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mock.state.graphCalls, calls); // no polls after stop()
    assert.ok(calls >= 3);
  } finally {
    db.close();
    await mock.close();
  }
});
