// SPDX-License-Identifier: BUSL-1.1
import {
  CLASS_TAP_DEFAULT_LIFETIME_MINUTES,
  type ClassStart,
  type ClassTapRequest,
} from './schemas/classTap.js';
import type { TapPolicy } from './schemas/temporaryAccessPass.js';
import { TAP_START_MESSAGE, tapRequestProblem, tapStartProblem } from './temporaryAccessPass.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The instant a wall-clock date and time is in an IANA time zone: what
 * `2026-11-02` at `09:00` in `Europe/London` means. A time a DST change
 * repeats is its first occurrence; one it skips moves forward to the
 * first instant that exists, when the clocks change.
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
  /** The zone's offset from UTC at an instant. */
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
  // The offsets either side of the day hold every reading of the wall time.
  const offsets = [...new Set([offsetAt(wall - DAY_MS), offsetAt(wall + DAY_MS)])];
  const readings = offsets.map((o) => wall - o).filter((t) => t + offsetAt(t) === wall);
  if (readings.length > 0) return new Date(Math.min(...readings));
  // Skipped: the clocks changed between these two, at a whole minute.
  let lo = Math.min(...offsets.map((o) => wall - o));
  let hi = Math.max(...offsets.map((o) => wall - o));
  const before = offsetAt(lo);
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetAt(mid) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
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

/** Said of a person whose class is on their start date when they have none. */
export const NO_START_DATE_MESSAGE =
  'Has no start date, so there’s no class for their pass to start at.';

/**
 * Why the tenant's policy, or the class's start, won't let these rows
 * have their passes: none when it will. The Options step shows them and
 * the final check refuses on them. A person whose start date is further
 * ahead than a pass can be made isn't one: their pass is made once it's
 * within reach.
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
    return problem ? [{ row: null, message: TAP_START_MESSAGE[problem] }] : [];
  }
  return rows.flatMap((r, row): ClassTapProblem[] => {
    const date = r.startDate ?? null;
    const at = classStartOf(start, date);
    if (!at || !date) return [{ row, message: NO_START_DATE_MESSAGE }];
    return tapStartProblem(at, now) === 'past'
      ? [{ row, message: `Their start date is ${date}. ${TAP_START_MESSAGE.past}` }]
      : [];
  });
}
