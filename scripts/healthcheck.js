// Docker healthcheck: healthy if the web server answers /api/health.
// (Poll/credential problems are shown in the UI and alerts, not by restarting the container.)

const port = process.env.PORT || '8080';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (res.ok) process.exit(0);
  console.error(`health returned ${res.status}`);
} catch (e) {
  console.error(`healthcheck error: ${e.message}`);
}
process.exit(1);
