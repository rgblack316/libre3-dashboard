// Time-of-day helpers (quiet hours, display dimming) with optional IANA time zone.

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseHHMM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

export function minutesOfDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// True when `ms` falls in [start, end). Handles windows that cross midnight (e.g. 22:00 to 07:00).
export function inWindow(ms, start, end, timeZone) {
  const a = parseHHMM(start);
  const b = parseHHMM(end);
  if (a === b) return false;
  const t = minutesOfDay(ms, timeZone);
  return a < b ? t >= a && t < b : t >= a || t < b;
}
