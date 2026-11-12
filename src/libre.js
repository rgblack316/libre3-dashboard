// Minimal client for the unofficial LibreLinkUp API (reverse-engineered, undocumented by Abbott).
// Zero dependencies: uses Node's built-in fetch and crypto.

import { createHash } from 'node:crypto';

const PRODUCT = 'llu.android';
const VERSION = '4.16.0'; // LibreLinkUp rejects very old app versions; bump if logins start failing.

export const TREND_LABELS = {
  1: 'falling fast',
  2: 'falling',
  3: 'steady',
  4: 'rising',
  5: 'rising fast',
};

export class LibreError extends Error {
  constructor(message, { code = 'ERROR', status } = {}) {
    super(message);
    this.name = 'LibreError';
    this.code = code;
    this.status = status;
  }
}

// LibreLinkUp timestamps look like "11/12/2026 5:20:15 PM" (M/D/YYYY, 12-hour).
// FactoryTimestamp is UTC; Timestamp is the sensor owner's local time with no zone.
export function parseLibreTimestamp(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: (AM|PM))?$/i);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  let h = Number(m[4]);
  const mi = Number(m[5]);
  const se = Number(m[6]);
  if (m[7]) {
    const pm = m[7].toUpperCase() === 'PM';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  return Number.isNaN(t) ? null : t;
}

// Turns one API measurement into { ts (UTC ms), value (mg/dL), trend (1-5|null), isHigh, isLow }.
// Only ValueInMgPerDl is trusted so units can never be mixed up; anything else is skipped.
export function normalizeMeasurement(m, { withTrend = false } = {}) {
  if (!m || typeof m !== 'object') return null;
  const ts = parseLibreTimestamp(m.FactoryTimestamp);
  const value = Number(m.ValueInMgPerDl);
  if (ts === null || !Number.isFinite(value) || value <= 0) return null;
  const trendOk = withTrend && Number.isInteger(m.TrendArrow) && m.TrendArrow >= 1 && m.TrendArrow <= 5;
  return {
    ts,
    value: Math.round(value),
    trend: trendOk ? m.TrendArrow : null,
    isHigh: Boolean(m.isHigh),
    isLow: Boolean(m.isLow),
  };
}

export class LibreLinkUpClient {
  constructor({
    email,
    password,
    region = '',
    baseUrl = '',
    patientId = '',
    regionBaseUrl = (r) => `https://api-${r}.libreview.io`,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
  } = {}) {
    if (!email || !password) throw new LibreError('Email and password are required', { code: 'CONFIG' });
    this.email = email;
    this.password = password;
    this.regionBaseUrl = regionBaseUrl;
    this.baseUrl = baseUrl || (region ? regionBaseUrl(region) : 'https://api.libreview.io');
    this.patientId = patientId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = null;
    this.accountId = null;
  }

  async #send(method, path, body, authed) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      product: PRODUCT,
      version: VERSION,
    };
    if (authed) {
      headers.Authorization = `Bearer ${this.token}`;
      headers['Account-Id'] = this.accountId;
    }
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new LibreError(`Network error: ${e.message}`, { code: 'NETWORK' });
    }
    if (res.status === 401) throw new LibreError('Unauthorized', { code: 'UNAUTHORIZED', status: 401 });
    if (res.status === 429) throw new LibreError('Rate limited by LibreLinkUp', { code: 'RATE_LIMIT', status: 429 });
    if (!res.ok) throw new LibreError(`HTTP ${res.status}`, { code: 'HTTP', status: res.status });
    try {
      return await res.json();
    } catch {
      throw new LibreError('Invalid JSON from LibreLinkUp', { code: 'BAD_RESPONSE' });
    }
  }

  async login() {
    this.token = null;
    const credentials = { email: this.email, password: this.password };
    let json = await this.#send('POST', '/llu/auth/login', credentials, false);

    // Accounts live in regional clusters; the global host may tell us to go elsewhere (once).
    if (json?.data?.redirect && json.data.region) {
      this.baseUrl = this.regionBaseUrl(json.data.region);
      json = await this.#send('POST', '/llu/auth/login', credentials, false);
    }

    const ticket = json?.data?.authTicket;
    const userId = json?.data?.user?.id;
    if (json?.status !== 0 || !ticket?.token || !userId) {
      const hint = json?.data?.step
        ? ' (LibreLinkUp may need an action in the app first, such as accepting updated terms)'
        : '';
      throw new LibreError(`Login failed (status ${json?.status})${hint}`, {
        code: json?.status === 2 ? 'BAD_CREDENTIALS' : 'LOGIN_FAILED',
      });
    }
    this.token = ticket.token;
    this.tokenExpiresAt = typeof ticket.expires === 'number' ? ticket.expires * 1000 : null;
    this.accountId = createHash('sha256').update(String(userId)).digest('hex');
  }

  async #ensureAuth() {
    const stale = this.tokenExpiresAt !== null && Date.now() > this.tokenExpiresAt - 60_000;
    if (!this.token || stale) await this.login();
  }

  async #authedGet(path) {
    await this.#ensureAuth();
    try {
      return await this.#send('GET', path, null, true);
    } catch (e) {
      if (e.code !== 'UNAUTHORIZED') throw e;
      await this.login(); // session expired early: log in again once and retry
      return this.#send('GET', path, null, true);
    }
  }

  async getConnections() {
    const json = await this.#authedGet('/llu/connections');
    return Array.isArray(json?.data) ? json.data : [];
  }

  async #pickPatient() {
    if (this.patientId) return this.patientId;
    const list = await this.getConnections();
    if (!list.length) {
      throw new LibreError(
        'No LibreLinkUp connections found. Share your data to this follower account from the Libre app.',
        { code: 'NO_CONNECTION' },
      );
    }
    this.patientId = list[0].patientId;
    return this.patientId;
  }

  // Returns { patientId, current, history }. current has a trend arrow; history points do not.
  async read() {
    const patientId = await this.#pickPatient();
    const json = await this.#authedGet(`/llu/connections/${encodeURIComponent(patientId)}/graph`);
    const data = json?.data;
    if (json?.status !== 0 || !data) {
      throw new LibreError(`Unexpected graph response (status ${json?.status})`, { code: 'BAD_RESPONSE' });
    }
    const current = normalizeMeasurement(data.connection?.glucoseMeasurement, { withTrend: true });
    const history = (Array.isArray(data.graphData) ? data.graphData : [])
      .map((m) => normalizeMeasurement(m))
      .filter(Boolean);
    return { patientId, current, history };
  }
}
