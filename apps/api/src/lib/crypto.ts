// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * Generate a 32-byte cryptographically random token, base64url-encoded.
 * Result is ~43 chars and URL/cookie safe. Used for admin session tokens.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token with SHA-256. The DB stores `token_hash`; the raw token
 * lives only in the user's cookie. A leak of the DB row therefore can't
 * forge the cookie on its own.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison to defeat timing-side-channel guesses.
 * Returns false on length mismatch (length differences are NOT a timing leak
 * worth the memory copy of equalizing — they leak only existence not contents).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
