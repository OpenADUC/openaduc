// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { lifetimeLabel, tapExpiresAt, tapRequestProblem } from './temporaryAccessPass.js';
import type { TapPolicy } from './schemas/temporaryAccessPass.js';

const policy: TapPolicy = {
  defaultLifetimeMinutes: 60,
  minLifetimeMinutes: 60,
  maxLifetimeMinutes: 480,
  usableOnceOnly: false,
};
const now = new Date('2026-10-24T12:00:00Z');
const request = { startsAt: null, lifetimeMinutes: 60, isUsableOnce: true };

describe('tapRequestProblem', () => {
  it('accepts a pass within the tenant policy', () => {
    expect(tapRequestProblem(policy, request, now)).toBeNull();
    expect(tapRequestProblem(policy, { ...request, lifetimeMinutes: 480 }, now)).toBeNull();
    expect(tapRequestProblem(policy, { ...request, isUsableOnce: false }, now)).toBeNull();
  });

  it('refuses a lifetime outside the tenant policy’s range, naming the range', () => {
    const problem = 'The tenant’s policy allows a lifetime from 1 hour to 8 hours.';
    expect(tapRequestProblem(policy, { ...request, lifetimeMinutes: 59 }, now)).toBe(problem);
    expect(tapRequestProblem(policy, { ...request, lifetimeMinutes: 481 }, now)).toBe(problem);
  });

  it('refuses a multi-use pass when the tenant allows only single-use passes', () => {
    expect(
      tapRequestProblem(
        { ...policy, usableOnceOnly: true },
        { ...request, isUsableOnce: false },
        now,
      ),
    ).toBe('The tenant’s policy allows only single-use passes.');
  });

  it('refuses a start in the past, allowing for clock skew', () => {
    const at = (iso: string) => ({ ...request, startsAt: iso });
    expect(tapRequestProblem(policy, at('2026-10-24T11:58:00Z'), now)).toBeNull();
    expect(tapRequestProblem(policy, at('2026-10-24T11:50:00Z'), now)).toBe(
      'The pass can’t start in the past.',
    );
    expect(tapRequestProblem(policy, at('2026-10-30T09:00:00Z'), now)).toBeNull();
  });

  it('refuses a start more than 30 days ahead', () => {
    const at = (iso: string) => ({ ...request, startsAt: iso });
    expect(tapRequestProblem(policy, at('2026-11-23T12:00:00Z'), now)).toBeNull();
    expect(tapRequestProblem(policy, at('2026-11-23T12:01:00Z'), now)).toBe(
      'The pass can start at most 30 days from now.',
    );
  });
});

describe('tapExpiresAt', () => {
  it('counts the lifetime from the start', () => {
    expect(tapExpiresAt('2026-10-24T12:00:00Z', 90).toISOString()).toBe('2026-10-24T13:30:00.000Z');
  });
});

describe('lifetimeLabel', () => {
  it('reads in the largest whole unit', () => {
    expect(lifetimeLabel(10)).toBe('10 minutes');
    expect(lifetimeLabel(60)).toBe('1 hour');
    expect(lifetimeLabel(90)).toBe('90 minutes');
    expect(lifetimeLabel(480)).toBe('8 hours');
    expect(lifetimeLabel(1440)).toBe('1 day');
    expect(lifetimeLabel(43200)).toBe('30 days');
  });
});
