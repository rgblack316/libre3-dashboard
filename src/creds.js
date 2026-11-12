// Stores the LibreLinkUp login entered on the admin page: password encrypted (AES-256-GCM) in SQLite,
// with the key kept in a separate 0600 file next to the database, so a copied/backed-up .db alone
// does not reveal the password.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadOrCreateKey(path) {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (existing.length === 32) return existing;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

function encrypt(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function createCredentialStore(db, key) {
  const KEY = 'llu_creds';
  return {
    // Returns { email, password, region } or null (also null if the key no longer matches).
    get() {
      const raw = db.getState(KEY);
      if (!raw) return null;
      try {
        const { email, region, pw } = JSON.parse(raw);
        return { email, region: region ?? '', password: decrypt(key, pw) };
      } catch {
        return null;
      }
    },
    set({ email, password, region = '' }) {
      db.setState(KEY, JSON.stringify({ email, region, pw: encrypt(key, password) }));
    },
  };
}
