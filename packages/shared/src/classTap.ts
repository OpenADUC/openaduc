// SPDX-License-Identifier: BUSL-1.1
import {
  CLASS_TAP_DEFAULT_LIFETIME_MINUTES,
  type ClassStart,
  type ClassTapRequest,
} from './schemas/classTap.js';
import { TAP_MAX_START_DAYS, type TapPolicy } from './schemas/temporaryAccessPass.js';
import { tapRequestProblem, tapStartProblem } from './temporaryAccessPass.js';

/**
 * The instant a wall-clock date and time is in an IANA time zone: what
 * `2026-11-02` at `09:00` in `Europe/London` means. A time a DST change
 * skips moves on by the hour skipped.
 */
export function zonedDateTime(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(instant)).map((p) => [p.type, Number(p.value)]),
    );
    const asWall = Date.UTC(
      parts['year']!,
      parts['month']! - 1,
      parts['day']!,
      parts['hour']!,
      parts['minute']!,
      parts['second']!,
    );
    return asWall - instant;
  };
  // The offset at a first guess, then at the instant that guess gives,
  // which is right unless the wall time falls in a DST change.
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/**
 * When class starts for someone whose start date is `startDate`; null
 * when it's each person's start date and they have none.
 */
export function classStartOf(start: ClassStart, startDate: string | null): Date | null {
  if (start.kind === 'fixed') return new Date(start.startsAt);
  return startDate ? zonedDateTime(startDate, start.time, start.timeZone) : null;
}

/** Issue TAPs for class as first offered: a class's length and multi-use, as far as the policy allows. */
export function classTapDefaults(
  policy: TapPolicy,
): Pick<ClassTapRequest, 'lifetimeMinutes' | 'isUsableOnce'> {
  return {
    lifetimeMinutes: Math.min(
      policy.maxLifetimeMinutes,
      Math.max(policy.minLifetimeMinutes, CLASS_TAP_DEFAULT_LIFETIME_MINUTES),
    ),
    isUsableOnce: policy.usableOnceOnly,
  };
}

export interface ClassTapProblem {
  /** The index of the row it's about, or null for the whole class. */
  row: number | null;
  message: string;
}

/**
 * Why the tenant's policy, or the class's start, won't let these rows
 * have their passes: none when it will. The Options step shows them and
 * the final check refuses on them.
 */
export function classTapProblems(
  classTap: ClassTapRequest,
  rows: readonly { startDate?: string | null | undefined }[],
  policy: TapPolicy,
  now: Date = new Date(),
): ClassTapProblem[] {
  const limits = tapRequestProblem(policy, { ...classTap, startsAt: null }, now);
  if (limits) return [{ row: null, message: limits }];
  const { start } = classTap;
  if (start.kind === 'fixed') {
    const problem = tapStartProblem(start.startsAt, now);
    if (problem === 'past') return [{ row: null, message: 'Class starts in the past.' }];
    if (problem === 'tooFar') {
      return [
        {
          row: null,
          message: `Class starts more than ${TAP_MAX_START_DAYS} days from now, further ahead than a pass can be made.`,
        },
      ];
    }
    return [];
  }
  return rows.flatMap((r, row): ClassTapProblem[] => {
    const date = r.startDate ?? null;
    const at = classStartOf(start, date);
    if (!at || !date) {
      return [
        { row, message: 'Has no start date, so there’s no class for their pass to start at.' },
      ];
    }
    const problem = tapStartProblem(at, now);
    if (problem === 'past') {
      return [
        { row, message: `Their start date, ${date}, has passed, so class can’t start then.` },
      ];
    }
    if (problem === 'tooFar') {
      return [
        {
          row,
          message: `Their start date, ${date}, is more than ${TAP_MAX_START_DAYS} days from now, further ahead than a pass can be made.`,
        },
      ];
    }
    return [];
  });
}
