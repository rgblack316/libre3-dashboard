// Entry point: polling, alerts and the web server (display at /display, settings at /admin).

import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const app = await createApp({ config });
const { port } = await app.start();
console.log(`Libre dashboard listening on port ${port} (display: /display, settings: /admin), database: ${config.dbPath}`);
if (!config.libre) console.log('No LibreLinkUp account in .env yet: add one on the admin page.');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
