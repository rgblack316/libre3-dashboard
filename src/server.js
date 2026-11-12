// HTTP server (node:http, no dependencies): static pages, public read-only API + live events (SSE)
// for the display, and a password-protected admin API.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { TREND_LABELS } from './libre.js';
import { computeStats, downsample } from './stats.js';
import { inWindow } from './time.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGES = { '/display': 'display.html', '/admin': 'admin.html' };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
const MAX_SSE_CLIENTS = 20;
const RANGES = { '24h': 24, '7d': 168, '14d': 336, '30d': 720 };
const COOKIE = 'sid';

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// A handler returns a plain object (sent as 200 JSON) or a Reply to control status and headers.
class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(text);
}

export function buildPublicState(ctx) {
  const s = ctx.settings.get();
  const now = ctx.now();
  const cur = ctx.db.latest();
  const dim = s.display.dim;
  const dimmed = dim.enabled && inWindow(now, dim.start, dim.end, s.system.timezone);
  return {
    serverNow: now,
    startedAt: ctx.startedAt,
    version: ctx.version,
    configured: ctx.configured(),
    current: cur ? { ts: cur.ts, value: cur.value, trend: cur.trend, isHigh: !!cur.is_high, isLow: !!cur.is_low } : null,
    thresholds: s.thresholds,
    staleMinutes: s.stale.minutes,
    alert: ctx.engine.getState(),
    display: {
      chartHours: s.display.chartHours,
      theme: s.display.theme,
      showChart: s.display.showChart,
      showStats: s.display.showStats,
      dimLevel: dimmed ? dim.level : 100,
    },
  };
}

function csvEscape(v) {
  return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

function parseTime(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n : Date.parse(v);
  if (!Number.isFinite(ms)) throw new HttpError(400, `Invalid date: ${v}`);
  return ms;
}

export function createHttpServer(ctx) {
  const clients = new Set();
  const routes = new Map();
  const route = (method, path, handler, { auth = false } = {}) => routes.set(`${method} ${path}`, { handler, auth });
  let lastTestLoginAt = 0;
  const statsCache = new Map();

  // ---- live events --------------------------------------------------------------------------

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(msg);
      } catch {
        clients.delete(res);
      }
    }
  }
  const broadcastState = () => broadcast('state', buildPublicState(ctx));

  function handleEvents(req, res) {
    if (clients.size >= MAX_SSE_CLIENTS) throw new HttpError(503, 'Too many display connections');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write('retry: 3000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(buildPublicState(ctx))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  // ---- public API ---------------------------------------------------------------------------

  route('GET', '/api/state', () => buildPublicState(ctx));

  route('GET', '/api/health', () => {
    let last = null;
    try {
      last = JSON.parse(ctx.db.getState('last_poll'));
    } catch {
      /* none yet */
    }
    const now = ctx.now();
    const recentOk = Boolean(last?.ok && now - last.at < 10 * 60_000);
    const booting = now - ctx.startedAt < 120_000;
    return { ok: recentOk || booting, lastPoll: last };
  });

  route('GET', '/api/readings', ({ query }) => {
    const hours = clamp(Number(query.get('hours') ?? 3) || 3, 1, 720);
    const maxPoints = clamp(Math.trunc(Number(query.get('maxPoints') ?? 600)) || 600, 50, 2000);
    const to = ctx.now();
    const rows = ctx.db.range(to - hours * 3600_000, to);
    const readings = downsample(rows, maxPoints).map((r) => ({ ts: r.ts, value: r.value, trend: r.trend ?? null }));
    return { hours, readings };
  });

  route('GET', '/api/stats', ({ query }) => {
    const range = query.get('range') ?? '24h';
    if (!(range in RANGES)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(', ')}`);
    const { low, high } = ctx.settings.get().thresholds;
    const now = ctx.now();
    const latestTs = ctx.db.latest()?.ts ?? 0;
    const cacheKey = `${range}|${low}|${high}|${latestTs}`;
    const hit = statsCache.get(range);
    if (hit && hit.key === cacheKey && now - hit.at < 30_000) return hit.value;
    const rangeMs = RANGES[range] * 3600_000;
    const rows = ctx.db.range(now - rangeMs, now);
    const value = { range, stats: computeStats(rows, { low, high, now, rangeMs }) };
    statsCache.set(range, { key: cacheKey, at: now, value });
    return value;
  });

  // ---- admin API ----------------------------------------------------------------------------

  route('GET', '/api/admin/session', ({ session }) => ({ authenticated: session }));

  route('POST', '/api/admin/login', async ({ req, body }) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const gate = ctx.auth.throttle.check(ip);
    if (!gate.allowed) {
      const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
      throw new HttpError(429, `Too many attempts. Try again in ${retryAfterSec}s.`, { retryAfterSec });
    }
    const ok = typeof body.password === 'string' && (await ctx.auth.verify(body.password));
    if (!ok) {
      ctx.auth.throttle.fail(ip);
      throw new HttpError(401, 'Wrong password');
    }
    ctx.auth.throttle.success(ip);
    const token = ctx.auth.sessions.create();
    return new Reply(200, { ok: true }, {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ctx.auth.sessions.maxAgeSeconds}`,
    });
  });

  route('POST', '/api/admin/logout', ({ token }) => {
    ctx.auth.sessions.destroy(token);
    return new Reply(200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }, { auth: true });

  route('GET', '/api/admin/settings', () => ({ settings: ctx.settings.get(), defaults: ctx.settings.defaults() }), { auth: true });

  route('PUT', '/api/admin/settings', ({ body }) => {
    const result = ctx.settings.update(body);
    if (!result.ok) throw new HttpError(400, 'Some settings are invalid', { errors: result.errors });
    ctx.onSettingsChanged();
    return { settings: result.settings };
  }, { auth: true });

  route('GET', '/api/admin/account', () => {
    const c = ctx.resolveCreds();
    return { email: c?.email ?? '', region: c?.region ?? '', hasPassword: Boolean(c?.password), source: ctx.credsSource() };
  }, { auth: true });

  route('PUT', '/api/admin/account', async ({ body }) => {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const region = typeof body.region === 'string' ? body.region.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !email.includes('@')) throw new HttpError(400, 'Enter the follower account email');
    if (region && !/^[a-z]{2}\d?$/.test(region)) throw new HttpError(400, 'Unknown region');
    const existing = ctx.resolveCreds();
    const password = typeof body.password === 'string' && body.password ? body.password : existing?.password;
    if (!password) throw new HttpError(400, 'Enter the follower account password');
    if (password.length > 200) throw new HttpError(400, 'Password too long');
    ctx.applyAccount({ email, password, region });
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/admin/test-login', async ({ body }) => {
    const wait = 5000 - (ctx.now() - lastTestLoginAt);
    if (wait > 0) throw new HttpError(429, `Wait ${Math.ceil(wait / 1000)}s before testing again`);
    lastTestLoginAt = ctx.now();
    const base = ctx.resolveCreds() ?? {};
    const creds = {
      email: (typeof body.email === 'string' && body.email.trim()) || base.email,
      password: (typeof body.password === 'string' && body.password) || base.password,
      region: typeof body.region === 'string' ? body.region.trim().toLowerCase() : (base.region ?? ''),
    };
    if (!creds.email || !creds.password) throw new HttpError(400, 'Enter an email and password first');
    try {
      const client = ctx.makeClient(creds);
      await client.login();
      const connections = await client.getConnections();
      const first = connections[0];
      const patient = first ? `${first.firstName ?? '?'} ${(first.lastName ?? '?')[0]}.` : null;
      return { ok: true, connections: connections.length, patient };
    } catch (e) {
      return { ok: false, error: { code: e.code ?? 'ERROR', message: e.message } };
    }
  }, { auth: true });

  route('POST', '/api/admin/password', async ({ body, token }) => {
    const { current, next } = body;
    if (typeof current !== 'string' || typeof next !== 'string') throw new HttpError(400, 'Current and new password are required');
    if (next.length < 8 || next.length > 200) throw new HttpError(400, 'New password must be 8 to 200 characters');
    if (!(await ctx.auth.verify(current))) throw new HttpError(403, 'Current password is wrong');
    await ctx.auth.setPassword(next);
    ctx.auth.sessions.destroyAllExcept(token);
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/admin/snooze', ({ body }) => {
    const minutes = body.minutes === undefined ? ctx.settings.get().alerts.snoozeMinutes : body.minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw new HttpError(400, 'Minutes must be 1 to 480');
    ctx.engine.snooze(minutes);
    return { alert: ctx.engine.getState() };
  }, { auth: true });

  route('POST', '/api/admin/snooze/clear', () => {
    ctx.engine.clearSnooze();
    return { alert: ctx.engine.getState() };
  }, { auth: true });

  route('POST', '/api/admin/ack', () => {
    ctx.engine.acknowledge();
    return { alert: ctx.engine.getState() };
  }, { auth: true });

  route('POST', '/api/admin/test-beep', () => {
    ctx.engine.testBeep();
    return { ok: true, displays: clients.size };
  }, { auth: true });

  route('POST', '/api/admin/poll-now', async () => {
    await ctx.poller.pollNow();
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/status', () => {
    let lastPoll = null;
    try {
      lastPoll = JSON.parse(ctx.db.getState('last_poll'));
    } catch {
      /* none yet */
    }
    let dbBytes = null;
    if (ctx.db.path !== ':memory:') {
      try {
        dbBytes = statSync(ctx.db.path).size;
      } catch {
        /* ignore */
      }
    }
    const cur = ctx.db.latest();
    return {
      version: ctx.version,
      startedAt: ctx.startedAt,
      now: ctx.now(),
      configured: ctx.configured(),
      credsSource: ctx.credsSource(),
      lastPoll,
      failures: ctx.poller.failures,
      pollSeconds: Math.round(ctx.poller.intervalMs / 1000),
      readings: ctx.db.count(),
      dbBytes,
      displays: clients.size,
      current: cur ? { ts: cur.ts, value: cur.value, trend: cur.trend, trendLabel: TREND_LABELS[cur.trend] ?? null } : null,
      alert: ctx.engine.getState(),
      timezone: ctx.settings.get().system.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }, { auth: true });

  route('GET', '/api/admin/alerts', ({ query }) => {
    const limit = clamp(Math.trunc(Number(query.get('limit') ?? 100)) || 100, 1, 500);
    return { alerts: ctx.db.recentAlerts(limit) };
  }, { auth: true });

  route('GET', '/api/admin/export.csv', async ({ res, query }) => {
    const to = parseTime(query.get('to'), ctx.now());
    const from = parseTime(query.get('from'), 0);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="glucose-readings.csv"',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.write('timestamp_utc,glucose_mg_dl,trend\n');
    let after = from - 1;
    for (;;) {
      const rows = ctx.db.page(after, to, 5000);
      if (!rows.length) break;
      let chunk = '';
      for (const r of rows) {
        chunk += `${new Date(r.ts).toISOString()},${r.value},${csvEscape(TREND_LABELS[r.trend] ?? '')}\n`;
      }
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      after = rows[rows.length - 1].ts;
    }
    res.end();
    return { handled: true };
  }, { auth: true });

  // ---- request handling ---------------------------------------------------------------------

  async function serveStatic(res, file) {
    const ext = file.slice(file.lastIndexOf('.'));
    let data;
    try {
      data = await readFile(join(PUBLIC_DIR, file));
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    const path = url.pathname;

    if (method === 'GET' && path === '/') {
      res.writeHead(302, { Location: '/display' });
      return res.end();
    }
    if (method === 'GET' && PAGES[path]) return serveStatic(res, PAGES[path]);
    if (method === 'GET' && path.startsWith('/static/')) {
      const name = path.slice('/static/'.length);
      if (!/^[a-z0-9._-]+\.(js|css|svg)$/i.test(name)) throw new HttpError(404, 'Not found');
      return serveStatic(res, name);
    }
    if (method === 'GET' && path === '/api/events') return handleEvents(req, res);

    const entry = routes.get(`${method} ${path}`);
    if (!entry) throw new HttpError(404, 'Not found');

    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = ctx.auth.sessions.valid(token);
    if (entry.auth && !session) throw new HttpError(401, 'Sign in required');

    let body = {};
    if (method !== 'GET') {
      // Cross-site requests can't send JSON without a CORS preflight, and we send no CORS headers.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        throw new HttpError(415, 'Content-Type must be application/json');
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          /* leave null */
        }
        if (originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
      }
      body = await readJson(req);
    }

    const out = await entry.handler({ req, res, url, query: url.searchParams, body, session, token });
    if (out?.handled) return;
    if (out instanceof Reply) return sendJson(res, out.status, out.body, out.headers);
    return sendJson(res, 200, out ?? { ok: true });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
      ctx.log(`request error: ${err.stack ?? err}`);
      return sendJson(res, 500, { error: 'Internal error' });
    });
  });
  server.requestTimeout = 30_000;

  return {
    server,
    broadcast,
    broadcastState,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
