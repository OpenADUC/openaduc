// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { aUserDetail } from '../../test/userDetail.js';
import { needsAttention } from './attention.js';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const HOUR_AGO = '2026-10-23T11:00:00.000Z';
const IN_12_HOURS = '2026-10-24T00:00:00.000Z';
const IN_2_DAYS = '2026-10-25T12:00:00.000Z';

describe('needsAttention, as the API’s issues filter decides it', () => {
  it.each([
    ['a locked account', { locked: true }],
    ['a password that must change', { passwordMustChange: true }],
    ['an expired password', { passwordExpiresAt: HOUR_AGO }],
    ['a password expiring within the window', { passwordExpiresAt: IN_12_HOURS }],
    ['an expired account', { accountExpiresAt: HOUR_AGO }],
    ['an account expiring within the window', { accountExpiresAt: IN_12_HOURS }],
  ])('keeps %s', (_, u) => {
    expect(needsAttention(aUserDetail(u), 1, NOW)).toBe(true);
  });

  it.each([
    ['a password expiring after the window', { passwordExpiresAt: IN_2_DAYS }],
    [
      'an expired password that never expires',
      { passwordExpiresAt: HOUR_AGO, passwordNeverExpires: true },
    ],
    ['a disabled account, whatever else is wrong', { enabled: false, locked: true }],
  ])('drops %s', (_, u) => {
    expect(needsAttention(aUserDetail(u), 1, NOW)).toBe(false);
  });
});
