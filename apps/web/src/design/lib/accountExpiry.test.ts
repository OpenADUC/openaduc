// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it } from 'vitest';
import { expiryAtEndOf, expiryMoment, expiryText, lastDayOf } from './accountExpiry.js';

// Local calendar days: the expiry is the midnight that ends the day, as ADUC
// writes it, in the operator's time zone. Node re-reads TZ when it changes.
const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata'];
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
});

describe.each(ZONES)('account expiry in %s', (zone) => {
  const inZone = () => (process.env.TZ = zone);

  it('ends a day at the next midnight, and reads it back as that day', () => {
    inZone();
    const endOfMar1 = day(2031, 3, 2).toISOString();
    expect(expiryAtEndOf(day(2031, 3, 1))).toBe(endOfMar1);
    expect(lastDayOf(endOfMar1)).toEqual(day(2031, 3, 1));
  });

  it('says "the end of" the last day for a midnight expiry', () => {
    inZone();
    const endOfMar1 = day(2031, 3, 2).toISOString();
    expect(expiryMoment(endOfMar1)).toBe(`the end of ${day(2031, 3, 1).toLocaleDateString()}`);
    expect(expiryText(endOfMar1)).toBe(
      `expires at the end of ${day(2031, 3, 1).toLocaleDateString()}`,
    );
  });

  it('gives the exact time for an expiry another tool set mid-day', () => {
    inZone();
    const afternoon = new Date(2031, 2, 1, 15, 30);
    expect(expiryMoment(afternoon.toISOString())).toBe(afternoon.toLocaleString());
    expect(expiryText(afternoon.toISOString(), true)).toBe(
      `Expires at ${afternoon.toLocaleString()}`,
    );
  });
});

it('says an account without an expiry never expires', () => {
  expect(expiryText(null)).toBe('never expires');
  expect(expiryText(null, true)).toBe('Never expires');
});
