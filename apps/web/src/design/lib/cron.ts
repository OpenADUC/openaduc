// SPDX-License-Identifier: BUSL-1.1
// Tiny cron-next-fire helper for the few patterns we actually use.
//
// Supports a 5-field POSIX-style schedule:  `m h dom mon dow`
// Each field is either:
//   - `*`        — any value
//   - `N`        — a single integer
//   - `*/N`      — every N steps from 0
// That covers the common "daily at 02:00" (`0 2 * * *`), "every six hours"
// (`0 */6 * * *`), and "every 15 minutes" (`*/15 * * * *`) defaults the API
// uses. Anything more exotic falls back to `null` (caller renders a
// "see schedule" message).
//
// Walks minute-by-minute up to one year ahead. Cheap (≤ 525,600 iterations)
// and avoids pulling in a cron-parser dependency.

export type CronMatcher = (value: number) => boolean;

interface ParsedCron {
  minute: CronMatcher;
  hour: CronMatcher;
  dayOfMonth: CronMatcher;
  month: CronMatcher;
  dayOfWeek: CronMatcher;
}

function parseField(field: string, min: number, max: number): CronMatcher | null {
  const f = field.trim();
  if (f === '*') return () => true;
  const stepMatch = /^\*\/(\d+)$/.exec(f);
  if (stepMatch) {
    const step = Number.parseInt(stepMatch[1] ?? '0', 10);
    if (!Number.isFinite(step) || step <= 0) return null;
    return (v) => v % step === 0;
  }
  const n = Number.parseInt(f, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return (v) => v === n;
}

export function parseCron(spec: string | null | undefined): ParsedCron | null {
  if (!spec) return null;
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dayOfMonth = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dayOfWeek = parseField(parts[4]!, 0, 6); // 0 = Sunday in standard cron
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * Return the next time the cron expression fires after `from`. Returns null
 * if we can't find a match within a year (unparseable / impossible
 * expression). Resolution is one minute.
 */
export function nextCronFire(
  spec: string | null | undefined,
  from: Date = new Date(),
): Date | null {
  const parsed = parseCron(spec);
  if (!parsed) return null;
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = 60 * 24 * 366;
  const cursor = new Date(start);
  for (let i = 0; i < limit; i++) {
    if (
      parsed.minute(cursor.getMinutes()) &&
      parsed.hour(cursor.getHours()) &&
      parsed.dayOfMonth(cursor.getDate()) &&
      parsed.month(cursor.getMonth() + 1) &&
      parsed.dayOfWeek(cursor.getDay())
    ) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** Format `ms` as a tight "1h 32m" / "12m 04s" countdown. */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
