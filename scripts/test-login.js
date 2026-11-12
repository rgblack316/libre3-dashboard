// One-shot check: log in, list connections, fetch one reading. Prints no secrets.
// Run with: npm run test-login

import { loadConfig } from '../src/config.js';
import { LibreLinkUpClient, TREND_LABELS } from '../src/libre.js';

try {
  const { libre } = loadConfig();
  if (!libre) throw new Error('LLU_EMAIL and LLU_PASSWORD must be set in .env (see .env.example).');
  const client = new LibreLinkUpClient(libre);

  await client.login();
  console.log('Login OK.');

  const connections = await client.getConnections();
  console.log(`Connections: ${connections.length}`);
  for (const c of connections) {
    console.log(`  - ${c.firstName ?? '?'} ${(c.lastName ?? '?')[0]}. (patientId ${c.patientId})`);
  }

  const { current, history } = await client.read();
  if (current) {
    const when = new Date(current.ts).toLocaleString();
    console.log(`Current: ${current.value} mg/dL, ${TREND_LABELS[current.trend] ?? 'trend unknown'} at ${when}`);
  } else {
    console.log('No current reading in the response (sensor warming up, or no recent data).');
  }

  if (history.length) {
    const first = new Date(history[0].ts).toLocaleString();
    const last = new Date(history.at(-1).ts).toLocaleString();
    console.log(`History: ${history.length} points from ${first} to ${last}`);
  }
} catch (e) {
  console.error(`Failed [${e.code ?? 'ERROR'}]: ${e.message}`);
  process.exit(1);
}
