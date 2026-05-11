// SPDX-License-Identifier: BUSL-1.1
import { promisify } from 'node:util';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Node's built-in scrypt is the right choice when we don't want a native dep:
// it's memory-hard (resistant to GPU/ASIC brute force) and is the default
// recommendation in OWASP's Password Storage Cheat Sheet.
//
// Stored format is a self-describing envelope so we can rotate parameters
// without a migration:
//   scrypt$<N>$<r>$<p>$<saltB64url>$<keyB64url>
//
// Defaults are scrypt's "interactive" parameter set tuned for ~70 ms on
// modern server hardware: N=2^15 (32768), r=8, p=1, 64-byte key. These can
// be raised over time and old hashes will continue to verify.

const scryptAsync = promisify<
  string | Buffer,
  Buffer,
  number,
  { N: number; r: number; p: number; maxmem?: number },
  Buffer
>(scrypt);

const DEFAULT_N = 32768;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_LEN);
  // scrypt's default maxmem (32 MiB) is too low for N=32768. 64 MiB headroom.
  const key = await scryptAsync(plaintext, salt, KEY_LEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scryptAsync(plaintext, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(64 * 1024 * 1024, 128 * N * r),
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
