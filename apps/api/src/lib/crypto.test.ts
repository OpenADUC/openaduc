// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, timingSafeEqual } from './crypto.js';

describe('generateToken', () => {
  it('produces a base64url string of consistent length', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding).
    expect(t.length).toBe(43);
  });

  it('is unique across calls with overwhelming probability', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateToken());
    expect(seen.size).toBe(1000);
  });
});

describe('hashToken', () => {
  it('produces a stable 64-char hex sha256 hash', () => {
    const h = hashToken('hello');
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is deterministic', () => {
    expect(hashToken('x')).toBe(hashToken('x'));
  });

  it('different inputs produce different hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });
  it('returns false for unequal strings of the same length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
  it('returns false for differing lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
