// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { classStartOf, classTapDefaults, classTapProblems, zonedDateTime } from './classTap.js';
import { classTapRequestSchema, type ClassTapRequest } from './schemas/classTap.js';
import type { TapPolicy } from './schemas/temporaryAccessPass.js';

const policy: TapPolicy = {
  defaultLifetimeMinutes: 60,
  minLifetimeMinutes: 60,
  maxLifetimeMinutes: 480,
  usableOnceOnly: false,
};
const now = new Date('2026-10-24T12:00:00Z');
const fixed = (startsAt: string, over: Partial<ClassTapRequest> = {}): ClassTapRequest => ({
  start: { kind: 'fixed', startsAt },
  lifetimeMinutes: 240,
  isUsableOnce: false,
  ...over,
});
const byStartDate: ClassTapRequest = {
  start: { kind: 'startDate', time: '09:00', timeZone: 'Europe/London' },
  lifetimeMinutes: 240,
  isUsableOnce: false,
};

describe('zonedDateTime', () => {
  const at = (date: string, time: string, zone: string) =>
    zonedDateTime(date, time, zone).toISOString();

  it('reads a wall-clock time in the zone, either side of a DST change', () => {
    expect(at('2026-10-20', '09:00', 'Europe/London')).toBe('2026-10-20T08:00:00.000Z');
    expect(at('2026-11-02', '09:00', 'Europe/London')).toBe('2026-11-02T09:00:00.000Z');
    expect(at('2026-11-02', '09:00', 'America/New_York')).toBe('2026-11-02T14:00:00.000Z');
    expect(at('2026-11-02', '09:30', 'Asia/Kolkata')).toBe('2026-11-02T04:00:00.000Z');
  });

  it('moves a time the clocks skip forward to when they change', () => {
    // 01:00 → 02:00 BST, 02:00 → 03:00 EDT, 02:00 → 03:00 AEDT.
    expect(at('2027-03-28', '01:30', 'Europe/London')).toBe('2027-03-28T01:00:00.000Z');
    expect(at('2027-03-14', '02:30', 'America/New_York')).toBe('2027-03-14T07:00:00.000Z');
    expect(at('2026-10-04', '02:30', 'Australia/Sydney')).toBe('2026-10-03T16:00:00.000Z');
  });

  it('reads a time the clocks repeat as its first occurrence', () => {
    expect(at('2026-10-25', '01:30', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z');
    expect(at('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(at('2027-04-04', '02:30', 'Australia/Sydney')).toBe('2027-04-03T15:30:00.000Z');
  });
});

describe('classStartOf', () => {
  it('starts everyone at one time, or each at their start date', () => {
    expect(classStartOf(fixed('2026-10-28T09:00:00Z').start, '2026-11-02')?.toISOString()).toBe(
      '2026-10-28T09:00:00.000Z',
    );
    expect(classStartOf(byStartDate.start, '2026-11-02')?.toISOString()).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(classStartOf(byStartDate.start, null)).toBeNull();
  });
});

describe('classTapDefaults', () => {
  it('offers a class’s length, multi-use, within the policy', () => {
    expect(classTapDefaults(policy)).toEqual({ lifetimeMinutes: 240, isUsableOnce: false });
    expect(classTapDefaults({ ...policy, maxLifetimeMinutes: 120, usableOnceOnly: true })).toEqual({
      lifetimeMinutes: 120,
      isUsableOnce: true,
    });
    expect(classTapDefaults({ ...policy, minLifetimeMinutes: 480 })).toMatchObject({
      lifetimeMinutes: 480,
    });
  });
});

describe('classTapProblems', () => {
  it('passes a class within the policy and the next 30 days', () => {
    expect(classTapProblems(fixed('2026-10-28T09:00:00Z'), [{}], policy, now)).toEqual([]);
    expect(classTapProblems(byStartDate, [{ startDate: '2026-11-02' }], policy, now)).toEqual([]);
  });

  it('holds the lifetime and use to the tenant’s policy', () => {
    expect(
      classTapProblems(fixed('2026-10-28T09:00:00Z', { lifetimeMinutes: 600 }), [{}], policy, now),
    ).toEqual([{ row: null, message: expect.stringContaining('1 hour to 8 hours') }]);
    expect(
      classTapProblems(
        fixed('2026-10-28T09:00:00Z'),
        [{}],
        { ...policy, usableOnceOnly: true },
        now,
      ),
    ).toEqual([{ row: null, message: 'The tenant’s policy allows only single-use passes.' }]);
  });

  it('refuses a class in the past or more than 30 days ahead', () => {
    expect(classTapProblems(fixed('2026-10-23T09:00:00Z'), [{}], policy, now)).toEqual([
      { row: null, message: 'The pass can’t start in the past.' },
    ]);
    expect(classTapProblems(fixed('2026-12-01T09:00:00Z'), [{}], policy, now)).toEqual([
      { row: null, message: 'The pass can start at most 30 days from now.' },
    ]);
  });

  it('names each row whose start date can’t start a pass, but not one further off', () => {
    expect(
      classTapProblems(
        byStartDate,
        [
          { startDate: '2026-11-02' },
          { startDate: null },
          { startDate: '2026-10-20' },
          { startDate: '2026-12-25' },
        ],
        policy,
        now,
      ),
    ).toEqual([
      { row: 1, message: expect.stringContaining('no start date') },
      { row: 2, message: 'Their start date is 2026-10-20. The pass can’t start in the past.' },
    ]);
  });
});

describe('classTapRequestSchema', () => {
  it('takes only a real time zone and a time of day', () => {
    expect(classTapRequestSchema.safeParse(byStartDate).success).toBe(true);
    const zone = { ...byStartDate, start: { ...byStartDate.start, timeZone: 'Mars/Olympus' } };
    expect(classTapRequestSchema.safeParse(zone).success).toBe(false);
    const time = { ...byStartDate, start: { ...byStartDate.start, time: '25:00' } };
    expect(classTapRequestSchema.safeParse(time).success).toBe(false);
  });
});
