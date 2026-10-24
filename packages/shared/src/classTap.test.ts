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
  it('reads a wall-clock time in the zone, either side of a DST change', () => {
    expect(zonedDateTime('2026-10-20', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-10-20T08:00:00.000Z',
    );
    expect(zonedDateTime('2026-11-02', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(zonedDateTime('2026-11-02', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-11-02T14:00:00.000Z',
    );
    expect(zonedDateTime('2026-11-02', '09:30', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-02T04:00:00.000Z',
    );
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
    ).toEqual([{ row: null, message: 'The tenant’s policy allows only one-time passes.' }]);
  });

  it('refuses a class in the past or more than 30 days ahead', () => {
    expect(classTapProblems(fixed('2026-10-23T09:00:00Z'), [{}], policy, now)).toEqual([
      { row: null, message: 'Class starts in the past.' },
    ]);
    expect(classTapProblems(fixed('2026-12-01T09:00:00Z'), [{}], policy, now)).toEqual([
      { row: null, message: expect.stringContaining('more than 30 days') },
    ]);
  });

  it('names each row whose start date can’t start a pass', () => {
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
      { row: 2, message: expect.stringContaining('2026-10-20, has passed') },
      { row: 3, message: expect.stringContaining('more than 30 days') },
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
