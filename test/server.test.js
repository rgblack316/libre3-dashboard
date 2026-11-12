import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createApp } from '../src/app.js';
import { LibreLinkUpClient } from '../src/libre.js';
import { startMock } from './mock-llu.js';

const ADMIN_PW = 'test-admin-pw';

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function boot({ withCreds = true } = {}) {
  const mock = await startMock({ start: Math.floor(Date.now() / 60_000) * 60_000 });
  const clock = { t: Date.now() };
  const config = {
    libre: withCreds ? { email: mock.email, password: mock.password, region: '', patientId: '' } : null,
    dbPath: ':memory:',
    port: 0,
    host: '127.0.0.1',
    adminPassword: ADMIN_PW,
  };
  const app = await createApp({
    config,
    secretKey: randomBytes(32),
    now: () => clock.t,
    log: () => {},
    makeClient: (c) => new LibreLinkUpClient({ email: c.email, password: c.password, baseUrl: mock.regionUrl }),
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;

  const call = (cookie) => async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, json, text };
  };

  const login = async (pw = ADMIN_PW) => {
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };

  return {
    app, mock, base, clock, call, login,
    anon: call(null),
    async admin() {
      const { res, cookie } = await login();
      assert.equal(res.status, 200);
      return call(cookie);
    },
    async close() {
      await app.stop();
      await mock.close();
    },
  };
}

// Reads server-sent events until `predicate(textSoFar)` is true.
async function readEvents(base, predicate, { onOpen } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let opened = false;
  const deadline = Date.now() + 4000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`SSE timeout. Got: ${text}`)), 4000)),
      ]);
      if (done) break;
      text += dec.decode(value);
      if (!opened && text.includes('event: state')) {
        opened = true;
        await onOpen?.();
      }
      if (predicate(text)) return text;
    }
    throw new Error(`SSE predicate never matched. Got: ${text}`);
  } finally {
    ctrl.abort();
  }
}

test('pages are served with security headers; traversal is refused', async () => {
  const s = await boot();
  try {
    for (const [path, type] of [['/display', 'text/html'], ['/admin', 'text/html'], ['/static/display.js', 'text/javascript'], ['/static/admin.css', 'text/css']]) {
      const res = await fetch(s.base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), new RegExp(type));
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
    }
    const root = await fetch(s.base + '/', { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/display');
    assert.equal((await fetch(s.base + '/static/%2e%2e%2fpackage.json')).status, 404);
    assert.equal((await fetch(s.base + '/static/display.html')).status, 404); // only js/css/svg
    assert.equal((await fetch(s.base + '/nope')).status, 404);
  } finally {
    await s.close();
  }
});

test('public API: state, readings, stats, health', async () => {
  const s = await boot();
  try {
    await waitFor(() => s.app.db.latest());
    const state = (await s.anon('GET', '/api/state')).json;
    assert.equal(state.current.value, 112);
    assert.equal(state.current.trend, 4);
    assert.equal(state.configured, true);
    assert.equal(state.thresholds.low, 70);
    assert.equal(state.display.chartHours, 3);
    assert.equal(state.display.dimLevel, 100);
    assert.ok(Math.abs(state.serverNow - Date.now()) < 5000);
    assert.equal('password' in state, false);

    const r = (await s.anon('GET', '/api/readings?hours=6&maxPoints=100')).json;
    assert.equal(r.readings.length, 13);
    assert.ok(r.readings.every((p) => typeof p.ts === 'number' && typeof p.value === 'number'));
    assert.ok(r.readings.every((p, i) => i === 0 || p.ts > r.readings[i - 1].ts));

    const st = (await s.anon('GET', '/api/stats?range=24h')).json;
    assert.equal(st.range, '24h');
    assert.equal(typeof st.stats.avg, 'number');
    assert.equal(st.stats.count, 13);
    assert.equal((await s.anon('GET', '/api/stats?range=bogus')).status, 400);

    const health = (await s.anon('GET', '/api/health')).json;
    assert.equal(health.ok, true);
    assert.equal(health.lastPoll.ok, true);
  } finally {
    await s.close();
  }
});

test('admin API requires a session; wrong password is refused', async () => {
  const s = await boot();
  try {
    for (const [method, path] of [
      ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings'], ['GET', '/api/admin/account'],
      ['GET', '/api/admin/status'], ['GET', '/api/admin/alerts'], ['GET', '/api/admin/export.csv'],
      ['POST', '/api/admin/snooze'], ['POST', '/api/admin/ack'], ['POST', '/api/admin/test-beep'],
      ['POST', '/api/admin/poll-now'], ['POST', '/api/admin/password'], ['POST', '/api/admin/test-login'],
    ]) {
      const res = await s.anon(method, path, method === 'GET' ? undefined : {});
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal((await s.anon('GET', '/api/admin/session')).json.authenticated, false);

    const bad = await s.login('wrong');
    assert.equal(bad.res.status, 401);
    assert.equal(bad.cookie, undefined);

    const { res, cookie } = await s.login();
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const admin = s.call(cookie);
    assert.equal((await admin('GET', '/api/admin/session')).json.authenticated, true);
    assert.equal((await admin('GET', '/api/admin/settings')).status, 200);

    // sign out kills the session
    assert.equal((await admin('POST', '/api/admin/logout', {})).status, 200);
    assert.equal((await admin('GET', '/api/admin/settings')).status, 401);
  } finally {
    await s.close();
  }
});

test('state-changing requests must be JSON and same-origin', async () => {
  const s = await boot();
  try {
    const plain = await fetch(`${s.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `{"password":"${ADMIN_PW}"}` });
    assert.equal(plain.status, 415);
    const form = await fetch(`${s.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${ADMIN_PW}` });
    assert.equal(form.status, 415);

    const cross = await s.anon('POST', '/api/admin/login', { password: ADMIN_PW }, { Origin: 'http://evil.example' });
    assert.equal(cross.status, 403);
    const same = await s.anon('POST', '/api/admin/login', { password: ADMIN_PW }, { Origin: s.base });
    assert.equal(same.status, 200);

    const tooBig = await s.anon('POST', '/api/admin/login', { password: 'x'.repeat(100_000) });
    assert.equal(tooBig.status, 413);
  } finally {
    await s.close();
  }
});

test('login is throttled after repeated failures, even for the right password', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.login('nope')).res.status, 401);
    const locked = await s.login(ADMIN_PW);
    assert.equal(locked.res.status, 429);
    const body = await locked.res.json();
    assert.ok(body.retryAfterSec > 0);
    s.clock.t += 61_000; // lock expires
    assert.equal((await s.login(ADMIN_PW)).res.status, 200);
  } finally {
    await s.close();
  }
});

test('settings: validated, applied live, and reflected on the public state', async () => {
  const s = await boot();
  try {
    const admin = await s.admin();
    const ok = await admin('PUT', '/api/admin/settings', {
      thresholds: { low: 80, high: 160 },
      display: { chartHours: 6, theme: 'light' },
      system: { pollSeconds: 90 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.settings.thresholds.low, 80);

    const state = (await s.anon('GET', '/api/state')).json;
    assert.equal(state.thresholds.low, 80);
    assert.equal(state.thresholds.high, 160);
    assert.equal(state.display.chartHours, 6);
    assert.equal(state.display.theme, 'light');
    assert.equal(s.app.poller.intervalMs, 90_000);

    const bad = await admin('PUT', '/api/admin/settings', { thresholds: { low: 200 }, display: { chartHours: 5 } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.errors.some((e) => e.field === 'display.chartHours'));
    assert.equal((await s.anon('GET', '/api/state')).json.thresholds.low, 80); // unchanged

    const got = (await admin('GET', '/api/admin/settings')).json;
    assert.equal(got.settings.display.chartHours, 6);
    assert.equal(got.defaults.display.chartHours, 3);
  } finally {
    await s.close();
  }
});

test('account: password is never returned; test-login does not save; saving switches the source', async () => {
  const s = await boot();
  try {
    const admin = await s.admin();
    const acct = await admin('GET', '/api/admin/account');
    assert.equal(acct.json.source, 'env');
    assert.equal(acct.json.email, s.mock.email);
    assert.equal(acct.json.hasPassword, true);
    assert.equal(acct.text.includes(s.mock.password), false);

    // wrong password: reported, not saved
    const wrong = await admin('POST', '/api/admin/test-login', { email: s.mock.email, password: 'wrong' });
    assert.equal(wrong.json.ok, false);
    assert.equal(wrong.json.error.code, 'BAD_CREDENTIALS');
    assert.equal((await admin('GET', '/api/admin/account')).json.source, 'env');

    // rate limit between tests
    assert.equal((await admin('POST', '/api/admin/test-login', {})).status, 429);
    s.clock.t += 6000;

    // blank fields fall back to the saved account
    const fine = await admin('POST', '/api/admin/test-login', {});
    assert.deepEqual([fine.json.ok, fine.json.connections, fine.json.patient], [true, 1, 'Test P.']);

    // validation
    assert.equal((await admin('PUT', '/api/admin/account', { email: 'nope' })).status, 400);
    assert.equal((await admin('PUT', '/api/admin/account', { email: 'a@b.co', region: 'Not A Region' })).status, 400);

    const saved = await admin('PUT', '/api/admin/account', { email: s.mock.email, password: s.mock.password, region: '' });
    assert.equal(saved.status, 200);
    const after = await admin('GET', '/api/admin/account');
    assert.equal(after.json.source, 'admin');
    assert.equal(after.text.includes(s.mock.password), false);
    assert.equal(s.app.db.getState('llu_creds').includes(s.mock.password), false); // encrypted at rest
  } finally {
    await s.close();
  }
});

test('no account yet: shows "not set up", then recovers once an account is saved', async () => {
  const s = await boot({ withCreds: false });
  try {
    const first = await waitFor(async () => {
      const st = (await s.anon('GET', '/api/state')).json;
      return st.alert.apiError ? st : null;
    });
    assert.equal(first.configured, false);
    assert.equal(first.current, null);
    assert.equal(first.alert.active, 'no_data');
    assert.equal(first.alert.apiError.code, 'NOT_CONFIGURED');

    const admin = await s.admin();
    assert.equal((await admin('PUT', '/api/admin/account', { email: s.mock.email, password: s.mock.password })).status, 200);
    const later = await waitFor(async () => {
      const st = (await s.anon('GET', '/api/state')).json;
      return st.current ? st : null;
    });
    assert.equal(later.configured, true);
    assert.equal(later.current.value, 112);
    assert.equal(later.alert.apiError, null);
    assert.equal(later.alert.active, null);
  } finally {
    await s.close();
  }
});

test('live events: initial state, state changes, and beeps (snooze/ack/test sound)', async () => {
  const s = await boot();
  try {
    await waitFor(() => s.app.db.latest());
    const admin = await s.admin();

    // test beep reaches a connected display
    const text = await readEvents(s.base, (t) => t.includes('event: beep'), {
      onOpen: async () => {
        const r = await admin('POST', '/api/admin/test-beep', {});
        assert.equal(r.json.displays, 1);
      },
    });
    assert.match(text, /event: state\ndata: \{.*"current":\{"ts":/);
    assert.match(text, /event: beep\ndata: \{"severity":"normal","key":"test"\}/);

    // a low reading causes an immediate state broadcast with the active alert and an urgent beep
    const seen = await readEvents(s.base, (t) => t.includes('"active":"urgent_low"') && t.includes('event: beep'), {
      onOpen: async () => {
        s.mock.state.now += 60_000;
        s.mock.state.value = 48;
        s.mock.state.trendArrow = 1;
        await admin('POST', '/api/admin/poll-now', {});
      },
    });
    assert.match(seen, /"severity":"urgent","key":"urgent_low"/);

    // snooze / ack / validation
    assert.equal((await admin('POST', '/api/admin/snooze', { minutes: 0 })).status, 400);
    const snoozed = await admin('POST', '/api/admin/snooze', { minutes: 15 });
    assert.ok(snoozed.json.alert.snoozedUntil > Date.now());
    const acked = await admin('POST', '/api/admin/ack', {});
    assert.equal(acked.json.alert.acknowledged, true);
    const cleared = await admin('POST', '/api/admin/snooze/clear', {});
    assert.equal(cleared.json.alert.snoozedUntil, null);

    const alerts = (await admin('GET', '/api/admin/alerts?limit=10')).json.alerts;
    assert.ok(alerts.some((a) => a.kind === 'glucose' && a.level === 'urgent_low' && a.event === 'start' && a.value === 48));

    const status = (await admin('GET', '/api/admin/status')).json;
    assert.equal(status.configured, true);
    assert.equal(status.credsSource, 'env');
    assert.equal(status.current.value, 48);
    assert.equal(status.current.trendLabel, 'falling fast');
    assert.equal(status.readings, 14);
    assert.equal(status.lastPoll.ok, true);
  } finally {
    await s.close();
  }
});

test('CSV export streams readings and honors the date range', async () => {
  const s = await boot();
  try {
    await waitFor(() => s.app.db.latest());
    const admin = await s.admin();

    const all = await admin('GET', '/api/admin/export.csv');
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-type'), /text\/csv/);
    assert.match(all.headers.get('content-disposition'), /attachment/);
    const lines = all.text.trim().split('\n');
    assert.equal(lines[0], 'timestamp_utc,glucose_mg_dl,trend');
    assert.equal(lines.length, 14); // header + 13 readings
    assert.match(lines.at(-1), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z,112,rising$/);

    const future = await admin('GET', `/api/admin/export.csv?from=${Date.now() + 86_400_000}`);
    assert.equal(future.text.trim().split('\n').length, 1);
    assert.equal((await admin('GET', '/api/admin/export.csv?from=garbage')).status, 400);
  } finally {
    await s.close();
  }
});

test('changing the admin password signs out other sessions but not this one', async () => {
  const s = await boot();
  try {
    const a = await s.admin();
    const b = await s.admin(); // second browser
    assert.equal((await a('POST', '/api/admin/password', { current: 'wrong', next: 'new-password-1' })).status, 403);
    assert.equal((await a('POST', '/api/admin/password', { current: ADMIN_PW, next: 'short' })).status, 400);
    assert.equal((await a('POST', '/api/admin/password', { current: ADMIN_PW, next: 'new-password-1' })).status, 200);

    assert.equal((await a('GET', '/api/admin/settings')).status, 200); // this session stays
    assert.equal((await b('GET', '/api/admin/settings')).status, 401); // the other is signed out
    assert.equal((await s.login(ADMIN_PW)).res.status, 401);
    assert.equal((await s.login('new-password-1')).res.status, 200);
  } finally {
    await s.close();
  }
});
