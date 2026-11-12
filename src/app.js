// Wires everything together: database, settings, auth, poller, alert engine and web server.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { LibreLinkUpClient, TREND_LABELS } from './libre.js';
import { Poller } from './poller.js';
import { AlertEngine } from './alerts.js';
import { createSettingsStore } from './settings.js';
import { createCredentialStore, loadOrCreateKey } from './creds.js';
import { createAuth } from './auth.js';
import { createHttpServer } from './server.js';

const defaultMakeClient = (c) =>
  new LibreLinkUpClient({ email: c.email, password: c.password, region: c.region ?? '', patientId: c.patientId ?? '' });

export async function createApp({ config, makeClient = defaultMakeClient, now = Date.now, log = console.log, secretKey } = {}) {
  const db = openDb(config.dbPath);
  const key = secretKey ?? loadOrCreateKey(join(dirname(config.dbPath), '.secret'));
  const settings = createSettingsStore(db);
  const creds = createCredentialStore(db, key);
  const auth = createAuth(db, { now });
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const startedAt = now();

  // Credentials saved on the admin page win over the ones in .env.
  const resolveCreds = () => creds.get() ?? (config.libre ? { ...config.libre } : null);
  let configured = Boolean(resolveCreds());
  const credsSource = () => (creds.get() ? 'admin' : config.libre ? 'env' : 'none');

  const initial = resolveCreds();
  const poller = new Poller({
    client: initial ? makeClient(initial) : null,
    db,
    intervalMs: settings.get().system.pollSeconds * 1000,
  });
  const engine = new AlertEngine({ db, getSettings: settings.get, now });

  let web;
  const ctx = {
    db, settings, creds, auth, poller, engine, makeClient, resolveCreds, credsSource, now, log, version, startedAt,
    configured: () => configured,
    applyAccount(c) {
      creds.set(c);
      configured = true;
      poller.setClient(makeClient(c));
      poller.pollNow();
      web.broadcastState();
    },
    onSettingsChanged() {
      poller.setIntervalMs(settings.get().system.pollSeconds * 1000);
      engine.onSettingsChanged();
      web.broadcastState();
    },
  };
  web = createHttpServer(ctx);

  poller.on('reading', (r) => engine.onReading(r));
  poller.on('poll', ({ inserted, current }) => {
    engine.onPollOk();
    web.broadcastState();
    if (!current) log(`poll ok: no current reading in response (+${inserted} stored)`);
    else log(`poll ok: ${current.value} mg/dL, ${TREND_LABELS[current.trend] ?? 'trend unknown'} (+${inserted} new, ${db.count()} total)`);
  });
  poller.on('pollError', (err) => {
    engine.onPollError(err);
    web.broadcastState();
    log(`poll failed [${err.code}]: ${err.message}. Retrying in ${Math.round(poller.nextDelay() / 1000)}s`);
  });
  engine.on('change', () => web.broadcastState());
  engine.on('beep', (b) => web.broadcast('beep', b));

  const timers = [];
  const every = (ms, fn) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    timers.push(t);
  };

  function prune() {
    const days = settings.get().system.retentionDays;
    if (days > 0) {
      const removed = db.pruneReadings(now() - days * 86_400_000);
      if (removed) log(`pruned ${removed} readings older than ${days} days`);
    }
    db.pruneAlerts(now() - 365 * 86_400_000);
  }

  return {
    db, poller, engine, settings, auth, web,
    async start() {
      const seeded = await auth.init(config.adminPassword);
      if (seeded.generated) {
        log(`Admin password (shown once, change it on the admin page): ${seeded.generated}`);
      }
      const port = await web.listen(config.port, config.host);
      poller.start();
      every(15_000, () => engine.tick());
      every(30_000, () => web.broadcastState()); // heartbeat: ages, dimming, keeps the display's connection alive
      every(20_000, () => web.broadcast('ping', {}));
      every(6 * 3600_000, prune);
      prune();
      return { port };
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await poller.stop();
      await web.close();
      db.close();
    },
  };
}
