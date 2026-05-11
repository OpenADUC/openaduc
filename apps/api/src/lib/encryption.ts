// SPDX-License-Identifier: BUSL-1.1
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from '../config/env.js';

// Self-describing envelope for AES-256-GCM ciphertext kept in the database.
// Format:  v1.<iv-b64url>.<ciphertext-b64url>.<tag-b64url>
//
// The version prefix lets us rotate the AEAD scheme later without ambiguity.
//
// `Crypter` decouples the key source from the rest of the codebase so the api
// (loadEnv) and the worker (its own loader) can both supply a key without one
// pulling in the other's env validator.

export class Crypter {
  private readonly keyBuf: Buffer;

  constructor(keyBase64: string) {
    const raw = Buffer.from(keyBase64, 'base64');
    if (raw.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must decode to exactly 32 bytes, got ${raw.length}. ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.keyBuf = raw;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12); // GCM standard
    const cipher = createCipheriv('aes-256-gcm', this.keyBuf, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      ct.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('unrecognized encryption envelope');
    }
    const iv = Buffer.from(parts[1]!, 'base64url');
    const ct = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== 12) throw new Error('invalid IV length');
    if (tag.length !== 16) throw new Error('invalid GCM tag length');
    const decipher = createDecipheriv('aes-256-gcm', this.keyBuf, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }
}

// ---- Convenience singleton bound to the api's env loader ------------------
// Existing api callers can keep using encryptSecret/decryptSecret. The worker
// constructs its own Crypter directly from its env.

let cached: Crypter | null = null;

function defaultCrypter(): Crypter {
  if (cached) return cached;
  cached = new Crypter(loadEnv().ENCRYPTION_KEY);
  return cached;
}

export function encryptSecret(plaintext: string): string {
  return defaultCrypter().encrypt(plaintext);
}

export function decryptSecret(envelope: string): string {
  return defaultCrypter().decrypt(envelope);
}

/** Test-only helper to reset the cached default Crypter when env changes between tests. */
export function _resetEncryptionKeyCache(): void {
  cached = null;
}
