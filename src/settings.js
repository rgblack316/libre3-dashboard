// Settings: defaults, strict validation, and persistence (JSON in the SQLite `state` table).
// All glucose values are mg/dL.

import { isValidTimeZone } from './time.js';

export const DEFAULT_SETTINGS = {
  thresholds: { urgentLow: 55, low: 70, high: 180, urgentHigh: 250 },
  alerts: {
    urgentLow: true,
    low: true,
    high: true,
    urgentHigh: false,
    stale: true,
    apiError: true,
    sound: true,
    repeatMinutes: 5,
    urgentRepeatMinutes: 2,
    snoozeMinutes: 30,
    snoozeUrgent: false, // urgent alerts ignore snooze unless this is on
    hysteresis: 5, // mg/dL back inside range needed before an alert clears
    quietHours: { enabled: false, start: '22:00', end: '07:00' }, // mutes sound for non-urgent alerts
  },
  stale: { minutes: 10 },
  display: {
    chartHours: 3,
    theme: 'dark',
    showChart: true,
    showStats: true,
    dim: { enabled: false, start: '22:00', end: '06:00', level: 40 },
  },
  system: { pollSeconds: 60, retentionDays: 0, timezone: '' },
};

const CHART_HOURS = [1, 3, 6, 12, 24];
const THEMES = ['dark', 'light'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);

function deepFreeze(o) {
  for (const v of Object.values(o)) if (isObject(v)) deepFreeze(v);
  return Object.freeze(o);
}

// Overlays `input` onto `base`, keeping only known keys with matching types.
export function mergeInto(base, input, errors, path = '') {
  const out = {};
  for (const key of Object.keys(base)) {
    const field = path ? `${path}.${key}` : key;
    const has = isObject(input) && Object.hasOwn(input, key);
    if (isObject(base[key])) {
      out[key] = mergeInto(base[key], has ? input[key] : undefined, errors, field);
    } else if (has) {
      if (typeof input[key] !== typeof base[key]) {
        errors.push({ field, message: `Expected a ${typeof base[key]}` });
        out[key] = base[key];
      } else {
        out[key] = input[key];
      }
    } else {
      out[key] = base[key];
    }
  }
  return out;
}

export function validate(s) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  const int = (field, v, min, max) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      err(field, `Must be a whole number from ${min} to ${max}`);
      return false;
    }
    return true;
  };

  const t = s.thresholds;
  const ok = [
    int('thresholds.urgentLow', t.urgentLow, 40, 100),
    int('thresholds.low', t.low, 55, 120),
    int('thresholds.high', t.high, 120, 350),
    int('thresholds.urgentHigh', t.urgentHigh, 150, 500),
  ].every(Boolean);
  if (ok) {
    if (t.urgentLow >= t.low) err('thresholds.urgentLow', 'Urgent low must be below the low threshold');
    if (t.low >= t.high) err('thresholds.low', 'Low must be below the high threshold');
    if (t.high >= t.urgentHigh) err('thresholds.urgentHigh', 'Urgent high must be above the high threshold');
  }

  const a = s.alerts;
  int('alerts.repeatMinutes', a.repeatMinutes, 1, 60);
  int('alerts.urgentRepeatMinutes', a.urgentRepeatMinutes, 1, 60);
  int('alerts.snoozeMinutes', a.snoozeMinutes, 5, 480);
  int('alerts.hysteresis', a.hysteresis, 0, 20);
  for (const k of ['start', 'end']) {
    if (!TIME_RE.test(a.quietHours[k])) err(`alerts.quietHours.${k}`, 'Use a 24-hour time like 22:00');
  }
  if (a.quietHours.enabled && a.quietHours.start === a.quietHours.end) {
    err('alerts.quietHours.end', 'Start and end must be different');
  }

  int('stale.minutes', s.stale.minutes, 3, 120);

  const d = s.display;
  if (!CHART_HOURS.includes(d.chartHours)) err('display.chartHours', `Choose one of ${CHART_HOURS.join(', ')} hours`);
  if (!THEMES.includes(d.theme)) err('display.theme', 'Choose dark or light');
  for (const k of ['start', 'end']) {
    if (!TIME_RE.test(d.dim[k])) err(`display.dim.${k}`, 'Use a 24-hour time like 22:00');
  }
  if (d.dim.enabled && d.dim.start === d.dim.end) err('display.dim.end', 'Start and end must be different');
  int('display.dim.level', d.dim.level, 10, 100);

  int('system.pollSeconds', s.system.pollSeconds, 30, 300);
  if (s.system.retentionDays !== 0) int('system.retentionDays', s.system.retentionDays, 30, 3650);
  if (s.system.timezone !== '' && !isValidTimeZone(s.system.timezone)) {
    err('system.timezone', 'Unknown time zone (use a name like America/New_York, or leave blank)');
  }
  return errors;
}

export function createSettingsStore(db) {
  const KEY = 'settings';

  function load() {
    try {
      const raw = db.getState(KEY);
      const merged = mergeInto(clone(DEFAULT_SETTINGS), raw ? JSON.parse(raw) : {}, []);
      if (validate(merged).length === 0) return deepFreeze(merged);
    } catch {
      /* fall through to defaults */
    }
    return deepFreeze(clone(DEFAULT_SETTINGS));
  }

  let current = load();
  let version = 1;

  return {
    get: () => current,
    getVersion: () => version,
    defaults: () => clone(DEFAULT_SETTINGS),

    // Applies a (possibly partial) settings object. Nothing is saved unless the whole result is valid.
    update(partial) {
      const errors = [];
      const merged = mergeInto(clone(current), partial, errors);
      if (errors.length) return { ok: false, errors };
      const problems = validate(merged);
      if (problems.length) return { ok: false, errors: problems };
      current = deepFreeze(merged);
      db.setState(KEY, JSON.stringify(current));
      version += 1;
      return { ok: true, settings: current };
    },
  };
}
