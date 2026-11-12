// SQLite storage using Node's built-in node:sqlite (no native modules to compile).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS readings (
      ts      INTEGER PRIMARY KEY,   -- UTC milliseconds
      value   INTEGER NOT NULL,      -- mg/dL
      trend   INTEGER,               -- 1 falling fast .. 5 rising fast
      is_high INTEGER NOT NULL DEFAULT 0,
      is_low  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_log (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    INTEGER NOT NULL,        -- UTC milliseconds
      kind  TEXT NOT NULL,           -- glucose | stale | api
      level TEXT,                    -- urgent_low | low | high | urgent_high | error code
      value INTEGER,                 -- mg/dL at the time (glucose alerts)
      event TEXT NOT NULL            -- start | end
    );
    CREATE INDEX IF NOT EXISTS alert_log_ts ON alert_log (ts);
  `);

  const upsert = db.prepare(`
    INSERT INTO readings (ts, value, trend, is_high, is_low) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ts) DO UPDATE SET
      value = excluded.value,
      trend = COALESCE(excluded.trend, readings.trend),
      is_high = excluded.is_high,
      is_low = excluded.is_low
  `);
  const COLS = 'ts, value, trend, is_high, is_low';
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM readings');
  const latestStmt = db.prepare(`SELECT ${COLS} FROM readings ORDER BY ts DESC LIMIT 1`);
  const rangeStmt = db.prepare(`SELECT ${COLS} FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts`);
  const pageStmt = db.prepare(`SELECT ${COLS} FROM readings WHERE ts > ? AND ts <= ? ORDER BY ts LIMIT ?`);
  const getState = db.prepare('SELECT value FROM state WHERE key = ?');
  const setState = db.prepare(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const insertAlert = db.prepare('INSERT INTO alert_log (ts, kind, level, value, event) VALUES (?, ?, ?, ?, ?)');
  const recentAlerts = db.prepare('SELECT id, ts, kind, level, value, event FROM alert_log ORDER BY id DESC LIMIT ?');
  const pruneReadings = db.prepare('DELETE FROM readings WHERE ts < ?');
  const pruneAlerts = db.prepare('DELETE FROM alert_log WHERE ts < ?');

  const count = () => Number(countStmt.get().n);

  return {
    path,
    count,
    latest: () => latestStmt.get() ?? null,
    range: (from, to) => rangeStmt.all(from, to),
    page: (afterTs, to, limit) => pageStmt.all(afterTs, to, limit),

    // Inserts or merges readings by timestamp. Returns how many rows were new.
    insertReadings(rows) {
      const before = count();
      db.exec('BEGIN');
      try {
        for (const r of rows) upsert.run(r.ts, r.value, r.trend, r.isHigh ? 1 : 0, r.isLow ? 1 : 0);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return count() - before;
    },

    logAlert: ({ ts, kind, level = null, value = null, event }) => insertAlert.run(ts, kind, level, value, event),
    recentAlerts: (limit = 100) => recentAlerts.all(limit),
    pruneReadings: (before) => Number(pruneReadings.run(before).changes),
    pruneAlerts: (before) => Number(pruneAlerts.run(before).changes),

    getState: (key) => getState.get(key)?.value ?? null,
    setState: (key, value) => setState.run(key, String(value)),
    close: () => db.close(),
  };
}
