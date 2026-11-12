// Reads configuration from environment variables (.env via Docker Compose or `node --env-file`).
// LibreLinkUp credentials are optional here: they can also be entered on the admin page.

export function loadConfig(env = process.env) {
  const email = (env.LLU_EMAIL ?? '').trim();
  const password = env.LLU_PASSWORD ?? '';
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number from 1 to 65535.');

  return {
    libre:
      email && password
        ? {
            email,
            password,
            region: (env.LLU_REGION ?? '').trim().toLowerCase(),
            patientId: (env.LLU_PATIENT_ID ?? '').trim(),
          }
        : null,
    port,
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || './data/readings.db',
    adminPassword: env.ADMIN_PASSWORD ?? '', // only used to seed the admin password on first start
  };
}
