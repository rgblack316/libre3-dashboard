// Admin authentication: scrypt password hashing, in-memory sessions, and login throttling.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEYLEN = 32;
const SESSION_MS = 12 * 3600_000;
const FREE_FAILS = 5;
const MAX_LOCK_MS = 15 * 60_000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function createAuth(db, { now = Date.now } = {}) {
  const HASH_KEY = 'admin_hash';
  const sessions = new Map(); // token -> expiresAt
  const throttle = new Map(); // ip -> { fails, lockedUntil }

  function purge() {
    const t = now();
    for (const [token, exp] of sessions) if (exp <= t) sessions.delete(token);
  }

  return {
    // Seeds the admin password on first run: ADMIN_PASSWORD if given, else a generated one.
    // Returns { generated } where generated is the plaintext only when we made one up.
    async init(envPassword) {
      if (db.getState(HASH_KEY)) return { generated: null };
      const generated = envPassword ? null : generatePassword();
      db.setState(HASH_KEY, await hashPassword(envPassword || generated));
      return { generated };
    },
    verify: (password) => verifyPassword(password, db.getState(HASH_KEY)),
    async setPassword(password) {
      db.setState(HASH_KEY, await hashPassword(password));
    },

    sessions: {
      create() {
        purge();
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, now() + SESSION_MS);
        return token;
      },
      valid(token) {
        if (!token) return false;
        const exp = sessions.get(token);
        if (!exp) return false;
        if (exp <= now()) {
          sessions.delete(token);
          return false;
        }
        return true;
      },
      destroy: (token) => sessions.delete(token),
      destroyAllExcept(keep) {
        for (const token of sessions.keys()) if (token !== keep) sessions.delete(token);
      },
      maxAgeSeconds: SESSION_MS / 1000,
    },

    // After 5 failed logins, lock out for 1 min, doubling up to 15 min. Reset on success.
    throttle: {
      check(ip) {
        const e = throttle.get(ip);
        const wait = e ? e.lockedUntil - now() : 0;
        return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true, retryAfterMs: 0 };
      },
      fail(ip) {
        const e = throttle.get(ip) ?? { fails: 0, lockedUntil: 0 };
        e.fails += 1;
        if (e.fails >= FREE_FAILS) {
          e.lockedUntil = now() + Math.min(60_000 * 2 ** (e.fails - FREE_FAILS), MAX_LOCK_MS);
        }
        throttle.set(ip, e);
      },
      success: (ip) => throttle.delete(ip),
    },
  };
}
