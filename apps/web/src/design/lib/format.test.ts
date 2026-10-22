// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { userStatus } from './format.js';

const now = new Date('2026-10-22T12:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

describe('userStatus', () => {
  it('reports must-change-password ahead of expiry dates', () => {
    expect(userStatus({ enabled: true, passwordMustChange: true }, now)).toBe('pwd-must-change');
  });

  it('still ranks locked and disabled first', () => {
    expect(userStatus({ enabled: true, locked: true, passwordMustChange: true }, now)).toBe(
      'locked',
    );
    expect(userStatus({ enabled: false, passwordMustChange: true }, now)).toBe('disabled');
  });

  it('classifies expiry dates', () => {
    expect(userStatus({ enabled: true, passwordExpiresAt: days(-1) }, now)).toBe('pwd-expired');
    expect(userStatus({ enabled: true, passwordExpiresAt: days(5) }, now)).toBe('pwd-expiring');
    expect(userStatus({ enabled: true, passwordExpiresAt: days(30) }, now)).toBe('active');
  });
});
