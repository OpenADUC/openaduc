// SPDX-License-Identifier: BUSL-1.1
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialCacheService } from './credentialCache.js';

describe('CredentialCacheService', () => {
  let cache: CredentialCacheService;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new CredentialCacheService(1000);
  });
  afterEach(() => {
    cache.stop();
    vi.useRealTimers();
  });

  const inMs = (ms: number) => new Date(Date.now() + ms);

  it('drops a password when its session ends, without anyone asking for it', () => {
    cache.set('a', 'pw', inMs(5000));

    vi.advanceTimersByTime(4000);
    expect(cache.size()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(cache.size()).toBe(0);
  });

  it('keeps a password whose end was extended', () => {
    cache.set('a', 'pw', inMs(5000));

    vi.advanceTimersByTime(4000);
    cache.extend('a', inMs(5000));
    vi.advanceTimersByTime(4000);
    expect(cache.get('a')).toBe('pw');
    vi.advanceTimersByTime(2000);
    expect(cache.size()).toBe(0);
  });
});
