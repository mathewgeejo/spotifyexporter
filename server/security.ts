import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';

export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [salt, value] = encoded.split(':');
  const expected = Buffer.from(value, 'hex'); const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export class Vault {
  private readonly key: Buffer;
  constructor(private readonly store: Store) {
    if (process.env.ENCRYPTION_KEY) this.key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
    else {
      const path = join(store.directory, 'encryption.key');
      try { this.key = readFileSync(path); }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        const key = randomBytes(32); writeFileSync(path, key, { mode: 0o600, flag: 'wx' }); this.key = key;
      }
    }
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  encrypt(value: unknown): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  decrypt<T>(encoded: string): T {
    const bytes = Buffer.from(encoded, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  get<T>(key: string): T | undefined { const value = this.store.setting(`secret:${key}`); return value ? this.decrypt<T>(value) : undefined; }
  set(key: string, value: unknown) { this.store.setSetting(`secret:${key}`, this.encrypt(value)); }
  remove(key: string) { this.store.run('DELETE FROM settings WHERE key=?', `secret:${key}`); }
}
