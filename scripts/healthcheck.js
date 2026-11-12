// Docker healthcheck: healthy if the last poll succeeded within the last 10 minutes.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MAX_AGE_MS = 10 * 60_000;
const dbPath = process.env.DB_PATH || './data/readings.db';

try {
  if (!existsSync(dbPath)) throw new Error('database not created yet');
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT value FROM state WHERE key = 'last_poll'").get();
  db.close();
  const poll = row ? JSON.parse(row.value) : null;
  if (poll?.ok && Date.now() - poll.at < MAX_AGE_MS) process.exit(0);
  console.error(poll ? `last poll: ${poll.ok ? 'ok but stale' : `failed (${poll.code})`}` : 'no poll recorded yet');
} catch (e) {
  console.error(`healthcheck error: ${e.message}`);
}
process.exit(1);
