// Entry point: poll LibreLinkUp and store readings. (Web server and display come next.)

import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { LibreLinkUpClient, TREND_LABELS } from './libre.js';
import { Poller } from './poller.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const db = openDb(config.dbPath);
const client = new LibreLinkUpClient(config.libre);
const poller = new Poller({ client, db, intervalMs: config.pollIntervalMs });

poller.on('poll', ({ inserted, current }) => {
  if (!current) {
    console.log(`poll ok: no current reading in response (+${inserted} stored)`);
    return;
  }
  const trend = TREND_LABELS[current.trend] ?? 'trend unknown';
  console.log(`poll ok: ${current.value} mg/dL, ${trend} (+${inserted} new, ${db.count()} total)`);
});

poller.on('pollError', (err) => {
  const retry = Math.round(poller.nextDelay() / 1000);
  console.error(`poll failed [${err.code}]: ${err.message}. Retrying in ${retry}s`);
});

function shutdown() {
  poller.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`Starting poller (every ${config.pollIntervalMs / 1000}s), database: ${config.dbPath}`);
poller.start();
