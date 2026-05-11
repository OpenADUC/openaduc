// SPDX-License-Identifier: BUSL-1.1
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Crypter, _resetEncryptionKeyCache, decryptSecret, encryptSecret } from './encryption.js';

// loadEnv() reads process.env once. Set the keys before importing only happens
// per-suite since vitest runs each file in its own isolate; within this file
// we still need to set env BEFORE the first call and reset between cases that
// change it.

const KEY = randomBytes(32).toString('base64');

beforeEach(() => {
  // Provide a full env so loadEnv() succeeds for the encryption module.
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.SESSION_COOKIE_SECRET = 'x'.repeat(32);
  process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
  process.env.AD_LDAP_URLS = 'ldaps://example';
  process.env.AD_DOMAIN = 'example.local';
  process.env.AD_BASE_DN = 'DC=example,DC=local';
  process.env.AD_SERVICE_ACCOUNT_UPN = 's@example.local';
  process.env.AD_SERVICE_ACCOUNT_PASSWORD = 'pw';
  process.env.BOOTSTRAP_ADMIN_GROUP_DN = 'CN=x,DC=x';
  process.env.ENCRYPTION_KEY = KEY;
  _resetEncryptionKeyCache();
});

afterEach(() => {
  _resetEncryptionKeyCache();
});

describe('encrypt/decrypt round-trip', () => {
  it('round-trips a short string', () => {
    const env = encryptSecret('hello');
    expect(env.startsWith('v1.')).toBe(true);
    expect(decryptSecret(env)).toBe('hello');
  });

  it('round-trips a long unicode string', () => {
    const s = '大丈夫'.repeat(500);
    expect(decryptSecret(encryptSecret(s))).toBe(s);
  });

  it('produces a different envelope per call (random IV)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });

  it('rejects malformed envelopes', () => {
    expect(() => decryptSecret('not-an-envelope')).toThrow();
    expect(() => decryptSecret('v2.x.y.z')).toThrow();
  });

  it('rejects tampered ciphertext (GCM tag fails)', () => {
    const env = encryptSecret('hello');
    const parts = env.split('.');
    // Flip a bit in the ciphertext segment.
    const ctBuf = Buffer.from(parts[2]!, 'base64url');
    ctBuf[0] = (ctBuf[0] ?? 0) ^ 0xff;
    parts[2] = ctBuf.toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});

describe('Crypter directly', () => {
  it('rejects keys that are not 32 bytes when constructed', () => {
    expect(() => new Crypter(Buffer.from('too short').toString('base64'))).toThrow(/32 bytes/);
  });

  it('different keys cannot decrypt each other', () => {
    const a = new Crypter(randomBytes(32).toString('base64'));
    const b = new Crypter(randomBytes(32).toString('base64'));
    const env = a.encrypt('hello');
    expect(() => b.decrypt(env)).toThrow();
  });
});
