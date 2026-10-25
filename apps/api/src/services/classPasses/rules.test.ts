// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  graphPassStatus,
  passWindow,
  reachableAt,
  recheckAt,
  syncRetryMs,
  timedPassStatus,
} from './rules.js';

const now = new Date('2026-10-24T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('passWindow', () => {
  it('starts a pass with class when class is still ahead', () => {
    expect(passWindow(at('2026-10-27T09:00:00Z'), 240, now)).toEqual({
      startsAt: '2026-10-27T09:00:00.000Z',
      lifetimeMinutes: 240,
      late: false,
    });
  });

  it('starts a pass made after class began now, lasting until class ends', () => {
    expect(passWindow(at('2026-10-24T11:00:00Z'), 240, now)).toEqual({
      startsAt: null,
      lifetimeMinutes: 180,
      late: true,
    });
  });

  it('makes no pass once class is over', () => {
    expect(passWindow(at('2026-10-24T08:00:00Z'), 240, now)).toBeNull();
  });
});

describe('syncRetryMs', () => {
  const minutes = (n: number) => n * 60_000;

  it('looks again after doubling waits, up to a quarter of an hour', () => {
    const farOff = at('2026-10-30T09:00:00Z');
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => syncRetryMs(n, farOff, now))).toEqual(
      [1, 2, 4, 8, 15, 15, 15].map(minutes),
    );
  });

  it('looks every five minutes at most once class is near', () => {
    expect(syncRetryMs(8, at('2026-10-24T13:00:00Z'), now)).toBe(minutes(5));
  });
});

describe('graphPassStatus', () => {
  it('names the pass Entra holds by its usability', () => {
    const status = (reason: string) =>
      graphPassStatus({ id: 'tap-1', methodUsabilityReason: reason }, 'tap-1').status;
    expect(['NotYetValid', 'EnabledByPolicy', 'OneTimeUsed', 'Expired'].map(status)).toEqual([
      'notYetValid',
      'usable',
      'used',
      'expired',
    ]);
  });

  it('says a pass was replaced only when Entra holds another', () => {
    expect(graphPassStatus({ id: 'tap-2', methodUsabilityReason: 'NotYetValid' }, 'tap-1')).toEqual(
      { status: 'replaced', message: expect.any(String) },
    );
    expect(graphPassStatus(null, 'tap-1')).toEqual({
      status: 'issued',
      message: 'Entra hasn’t listed it yet.',
    });
  });
});

describe('timedPassStatus', () => {
  it('reads a pass’s times when Graph can’t be asked', () => {
    const pass = (start: string, end: string) => ({ startsAt: at(start), expiresAt: at(end) });
    expect(timedPassStatus(pass('2026-10-25T09:00:00Z', '2026-10-25T13:00:00Z'), now)).toBe(
      'notYetValid',
    );
    expect(timedPassStatus(pass('2026-10-24T11:00:00Z', '2026-10-24T15:00:00Z'), now)).toBe(
      'issued',
    );
    expect(timedPassStatus(pass('2026-10-24T07:00:00Z', '2026-10-24T11:00:00Z'), now)).toBe(
      'expired',
    );
  });
});

describe('reachableAt', () => {
  it('makes a pass once class is within 30 days', () => {
    expect(reachableAt(at('2026-12-20T09:00:00Z')).toISOString()).toBe('2026-11-20T09:10:00.000Z');
  });
});

describe('recheckAt', () => {
  it('checks a pass’s holder daily, and once more two hours before class', () => {
    expect(recheckAt(at('2026-10-30T09:00:00Z'), now).toISOString()).toBe(
      '2026-10-25T12:00:00.000Z',
    );
    expect(recheckAt(at('2026-10-24T18:00:00Z'), now).toISOString()).toBe(
      '2026-10-24T16:00:00.000Z',
    );
    expect(recheckAt(at('2026-10-24T13:00:00Z'), now).toISOString()).toBe(
      '2026-10-25T12:00:00.000Z',
    );
  });
});
