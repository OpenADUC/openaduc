// SPDX-License-Identifier: BUSL-1.1

/**
 * The lockout duration that applies to an account, in ms: its resultant
 * fine-grained password policy's when one applies, else the domain's.
 * 0 = until someone unlocks it; null = unknown, including a PSO that
 * applies but can't be read, whose duration the domain's says nothing about.
 */
export async function lockoutDurationFor(
  resultantPsoDn: string | null,
  read: {
    domain: () => Promise<number | null>;
    pso: (dn: string) => Promise<number | null>;
  },
): Promise<number | null> {
  return resultantPsoDn ? read.pso(resultantPsoDn) : read.domain();
}

/** When a lockout that began at `lockedAt` ends, given its duration. */
export function lockoutEnd(
  lockedAt: Date,
  durationMs: number | null,
): { autoUnlockAt: Date | null; lockedUntilUnlocked: boolean } {
  if (durationMs === 0) return { autoUnlockAt: null, lockedUntilUnlocked: true };
  if (durationMs === null) return { autoUnlockAt: null, lockedUntilUnlocked: false };
  return { autoUnlockAt: new Date(lockedAt.getTime() + durationMs), lockedUntilUnlocked: false };
}
