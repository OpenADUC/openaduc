// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { expiryAtEndOf, expiryText, lastDayOf } from './accountExpiry.js';

// Local calendar days: the expiry is the midnight that ends the day, as ADUC
// writes it, in the operator's time zone.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const END_OF_MAR_1 = day(2031, 3, 2).toISOString();

describe('expiry days', () => {
  it('ends a day at the next midnight, and reads it back as that day', () => {
    expect(expiryAtEndOf(day(2031, 3, 1))).toBe(END_OF_MAR_1);
    expect(lastDayOf(END_OF_MAR_1)).toEqual(day(2031, 3, 1));
  });

  it('says when the account expires', () => {
    expect(expiryText(END_OF_MAR_1)).toBe(
      `expires at the end of ${day(2031, 3, 1).toLocaleDateString()}`,
    );
    expect(expiryText(null)).toBe('never expires');
  });
});
