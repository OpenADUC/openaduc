// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from 'vitest';
import { lockoutDurationFor, lockoutEnd } from './lockout.js';

const PSO = 'CN=Contractors,CN=Password Settings Container,CN=System,DC=corp';
const HOUR = 3_600_000;

describe('lockoutDurationFor', () => {
  it('uses the domain policy when no PSO applies', async () => {
    const pso = vi.fn();
    expect(await lockoutDurationFor(null, { domain: async () => 0, pso })).toBe(0);
    expect(pso).not.toHaveBeenCalled();
  });

  it('uses the resultant PSO’s duration over the domain’s', async () => {
    const pso = vi.fn(async () => HOUR);
    expect(await lockoutDurationFor(PSO, { domain: async () => 0, pso })).toBe(HOUR);
    expect(pso).toHaveBeenCalledWith(PSO);
  });

  it('is unknown when a PSO applies but can’t be read, whatever the domain says', async () => {
    expect(await lockoutDurationFor(PSO, { domain: async () => 0, pso: async () => null })).toBe(
      null,
    );
  });
});

describe('lockoutEnd', () => {
  const lockedAt = new Date('2026-10-23T12:00:00.000Z');

  it('ends after the duration', () => {
    expect(lockoutEnd(lockedAt, HOUR)).toEqual({
      autoUnlockAt: new Date('2026-10-23T13:00:00.000Z'),
      lockedUntilUnlocked: false,
    });
  });

  it('lasts until someone unlocks it with no duration', () => {
    expect(lockoutEnd(lockedAt, 0)).toEqual({ autoUnlockAt: null, lockedUntilUnlocked: true });
  });

  it('claims nothing when the duration is unknown', () => {
    expect(lockoutEnd(lockedAt, null)).toEqual({ autoUnlockAt: null, lockedUntilUnlocked: false });
  });
});
