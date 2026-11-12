// A fake LibreLinkUp server for tests. Mimics the login redirect, auth headers, and graph response.

import http from 'node:http';
import { createHash } from 'node:crypto';

// "11/12/2026 5:20:15 PM" in UTC
export function formatLibreTimestamp(ms) {
  const d = new Date(ms);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h12}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

export async function startMock({
  email = 'follower@example.com',
  password = 'secret',
  userId = 'user-123',
  patientId = 'patient-1',
  redirectRegion = null,
} = {}) {
  const start = Date.UTC(2026, 10, 12, 17, 20, 0);
  const state = {
    now: start,
    value: 112,
    trendArrow: 4,
    loginCalls: 0,
    graphCalls: 0,
    validToken: null,
    expireNext: false,
    loginHeaders: null,
    lastAuthHeaders: null,
    // Fixed history: 12 points, 5 minutes apart, ending 5 minutes before `start`.
    history: Array.from({ length: 12 }, (_, i) => ({ ts: start - (12 - i) * 5 * 60_000, value: 100 + i })),
  };

  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const measurement = (ts, value, extra = {}) => ({
    FactoryTimestamp: formatLibreTimestamp(ts),
    Timestamp: formatLibreTimestamp(ts - 5 * 3600_000), // local time, deliberately different
    ValueInMgPerDl: value,
    Value: value / 18,
    isHigh: value > 180,
    isLow: value < 70,
    ...extra,
  });

  const handler = (isRegional) => (req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');

      if (req.method === 'POST' && url.pathname === '/llu/auth/login') {
        state.loginCalls += 1;
        state.loginHeaders = req.headers;
        if (redirectRegion && !isRegional) return send(res, 200, { status: 0, data: { redirect: true, region: redirectRegion } });
        const body = JSON.parse(raw || '{}');
        if (body.email !== email || body.password !== password) {
          return send(res, 200, { status: 2, error: { message: 'notAuthenticated' } });
        }
        state.validToken = `tok-${state.loginCalls}`;
        return send(res, 200, {
          status: 0,
          data: {
            user: { id: userId },
            authTicket: { token: state.validToken, expires: Math.floor(Date.now() / 1000) + 3600, duration: 3_600_000 },
          },
        });
      }

      if (redirectRegion && !isRegional) return send(res, 404, {});

      // Everything below needs a valid session.
      state.lastAuthHeaders = req.headers;
      if (state.expireNext) {
        state.expireNext = false;
        state.validToken = null;
        return send(res, 401, {});
      }
      const accountId = createHash('sha256').update(userId).digest('hex');
      if (req.headers.authorization !== `Bearer ${state.validToken}` || req.headers['account-id'] !== accountId) {
        return send(res, 401, {});
      }

      if (url.pathname === '/llu/connections') {
        return send(res, 200, { status: 0, data: [{ patientId, firstName: 'Test', lastName: 'Person' }] });
      }
      if (url.pathname === `/llu/connections/${patientId}/graph`) {
        state.graphCalls += 1;
        return send(res, 200, {
          status: 0,
          data: {
            connection: {
              patientId,
              glucoseMeasurement: measurement(state.now, state.value, { TrendArrow: state.trendArrow }),
            },
            activeSensors: [],
            graphData: state.history.map((p) => measurement(p.ts, p.value)),
          },
        });
      }
      return send(res, 404, {});
    });
  };

  const mainServer = http.createServer(handler(false));
  const regionalServer = http.createServer(handler(true));
  const url = await listen(mainServer);
  const regionUrl = await listen(regionalServer);

  return {
    url,
    regionUrl,
    state,
    email,
    password,
    userId,
    close: () => Promise.all([mainServer, regionalServer].map((s) => new Promise((r) => (s.closeAllConnections?.(), s.close(r))))),
  };
}
