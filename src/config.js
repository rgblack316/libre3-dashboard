// Reads configuration from environment variables (loaded from .env via `node --env-file`).

export function loadConfig(env = process.env) {
  const email = (env.LLU_EMAIL ?? '').trim();
  const password = env.LLU_PASSWORD ?? '';
  if (!email || !password) {
    throw new Error('LLU_EMAIL and LLU_PASSWORD must be set in .env (see .env.example).');
  }

  const seconds = Number(env.POLL_INTERVAL_SECONDS || 60);
  if (!Number.isFinite(seconds) || seconds < 30) {
    throw new Error('POLL_INTERVAL_SECONDS must be a number of at least 30.');
  }

  return {
    libre: {
      email,
      password,
      region: (env.LLU_REGION ?? '').trim().toLowerCase(),
      patientId: (env.LLU_PATIENT_ID ?? '').trim(),
    },
    pollIntervalMs: seconds * 1000,
    dbPath: env.DB_PATH || './data/readings.db',
  };
}
