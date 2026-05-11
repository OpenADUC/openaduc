// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { isDueNow } from './scheduler.js';
import { computeNextDueAt } from './service.js';
import { validateCron } from './cron.js';
import type { SyncTaskRow } from './service.js';

// Builder so each test focuses on the dimension under test instead of the
// boilerplate row shape.
function row(overrides: Partial<SyncTaskRow> = {}): SyncTaskRow {
  return {
    taskKey: 'users.delta',
    enabled: true,
    scheduleKind: 'interval',
    intervalMinutes: 15,
    anchorAt: null,
    monthlyDay: null,
    cronExpr: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastError: null,
    lastCursor: null,
    lastStats: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Build a Date for a specific local-time HH:MM today. */
function timeOnly(hours: number, minutes: number): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

describe('isDueNow (no anchor)', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('is due when never run', () => {
    expect(isDueNow(row({ lastStartedAt: null }), now)).toBe(true);
  });

  it('is not due when interval has not elapsed', () => {
    const lastStartedAt = new Date(now.getTime() - 5 * 60_000); // 5 min ago, interval 15
    expect(isDueNow(row({ lastStartedAt }), now)).toBe(false);
  });

  it('is due exactly at the interval boundary', () => {
    const lastStartedAt = new Date(now.getTime() - 15 * 60_000);
    expect(isDueNow(row({ lastStartedAt }), now)).toBe(true);
  });

  it('is due past the interval boundary', () => {
    const lastStartedAt = new Date(now.getTime() - 60 * 60_000);
    expect(isDueNow(row({ lastStartedAt }), now)).toBe(true);
  });

  it('is never due when interval is zero or negative', () => {
    expect(isDueNow(row({ intervalMinutes: 0 }), now)).toBe(false);
    expect(isDueNow(row({ intervalMinutes: -1 }), now)).toBe(false);
  });
});

describe('isDueNow (anchored)', () => {
  // Anchor at midnight, interval daily — expect due once per day at 00:00.
  const anchorAt = new Date('2026-05-09T00:00:00Z');

  it('is not due before the anchor', () => {
    const before = new Date('2026-05-08T23:30:00Z');
    expect(isDueNow(row({ intervalMinutes: 1440, anchorAt, lastStartedAt: null }), before)).toBe(
      false,
    );
  });

  it('is due at the anchor when never run', () => {
    expect(isDueNow(row({ intervalMinutes: 1440, anchorAt, lastStartedAt: null }), anchorAt)).toBe(
      true,
    );
  });

  it('is not due again within the same slot', () => {
    const lastStartedAt = new Date(anchorAt.getTime() + 5_000); // ran 5s after the slot
    const now = new Date(anchorAt.getTime() + 6 * 60 * 60_000); // 6h later
    expect(isDueNow(row({ intervalMinutes: 1440, anchorAt, lastStartedAt }), now)).toBe(false);
  });

  it('is due again at the next slot boundary', () => {
    const lastStartedAt = new Date(anchorAt.getTime() + 5_000);
    const nextSlot = new Date(anchorAt.getTime() + 1440 * 60_000);
    expect(isDueNow(row({ intervalMinutes: 1440, anchorAt, lastStartedAt }), nextSlot)).toBe(true);
  });

  it('catches up if a slot was missed (e.g. process down)', () => {
    // Anchor at 00:00, ran at 00:01 the day before, now is the day-after-next 12:00.
    const lastStartedAt = new Date(anchorAt.getTime() + 60_000);
    const now = new Date(anchorAt.getTime() + 2 * 1440 * 60_000 + 12 * 60 * 60_000);
    expect(isDueNow(row({ intervalMinutes: 1440, anchorAt, lastStartedAt }), now)).toBe(true);
  });

  it('handles 5-minute slots cleanly', () => {
    // Anchor 00:00, interval 5m, ran at 00:02. At 00:04 not due, at 00:05 due.
    const at5min = new Date(anchorAt.getTime() + 5 * 60_000);
    const at4min = new Date(anchorAt.getTime() + 4 * 60_000);
    const lastStartedAt = new Date(anchorAt.getTime() + 2 * 60_000);
    expect(isDueNow(row({ intervalMinutes: 5, anchorAt, lastStartedAt }), at4min)).toBe(false);
    expect(isDueNow(row({ intervalMinutes: 5, anchorAt, lastStartedAt }), at5min)).toBe(true);
  });
});

describe('computeNextDueAt', () => {
  it('returns now when never run, no anchor (interval)', () => {
    const before = Date.now();
    const next = computeNextDueAt({
      scheduleKind: 'interval',
      intervalMinutes: 15,
      anchorAt: null,
      monthlyDay: null,
      cronExpr: null,
      lastStartedAt: null,
    });
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns last + interval when no anchor and last is set', () => {
    const lastStartedAt = new Date('2026-05-09T12:00:00Z');
    const next = computeNextDueAt({
      scheduleKind: 'interval',
      intervalMinutes: 15,
      anchorAt: null,
      monthlyDay: null,
      cronExpr: null,
      lastStartedAt,
    });
    expect(next?.toISOString()).toBe('2026-05-09T12:15:00.000Z');
  });

  it('returns null when interval is zero', () => {
    expect(
      computeNextDueAt({
        scheduleKind: 'interval',
        intervalMinutes: 0,
        anchorAt: null,
        monthlyDay: null,
        cronExpr: null,
        lastStartedAt: null,
      }),
    ).toBeNull();
  });
});

// ---- Cron ----------------------------------------------------------------

describe('validateCron', () => {
  it('accepts valid 5-field expressions', () => {
    expect(validateCron('*/5 * * * *').ok).toBe(true);
    expect(validateCron('0 2 * * 1-5').ok).toBe(true);
    expect(validateCron('15 0,6,12,18 * * *').ok).toBe(true);
  });

  it('rejects empty / whitespace input', () => {
    expect(validateCron('').ok).toBe(false);
    expect(validateCron('   ').ok).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(validateCron('not-a-cron').ok).toBe(false);
    expect(validateCron('99 * * * *').ok).toBe(false);
    expect(validateCron('* * * 13 *').ok).toBe(false);
  });
});

describe('isDueNow (cron)', () => {
  // cron-parser interprets expressions in the system's local TZ to
  // match what operators picked. Tests stay TZ-invariant by deriving
  // the "last run" timestamp from the actual previous slot rather than
  // asserting absolute UTC clock times.

  it('is due when last_started_at is before the most recent slot', () => {
    const expr = '*/5 * * * *'; // every 5 minutes — TZ-invariant
    const now = new Date();
    // Most recent slot is at most 5 min ago; setting last to 10 min ago
    // guarantees last < prev_slot regardless of where 'now' lands.
    const lastBefore = new Date(now.getTime() - 10 * 60_000);
    expect(
      isDueNow(row({ scheduleKind: 'cron', cronExpr: expr, lastStartedAt: lastBefore }), now),
    ).toBe(true);
  });

  it('is not due if already ran after the most recent slot', () => {
    const expr = '*/5 * * * *';
    const now = new Date();
    // Last ran 1 second before now → after the most recent :M0/:M5 slot.
    const lastAfter = new Date(now.getTime() - 1_000);
    expect(
      isDueNow(row({ scheduleKind: 'cron', cronExpr: expr, lastStartedAt: lastAfter }), now),
    ).toBe(false);
  });

  it('is not due when cronExpr is null', () => {
    const now = new Date();
    expect(isDueNow(row({ scheduleKind: 'cron', cronExpr: null }), now)).toBe(false);
  });

  it('is not due when cronExpr is invalid', () => {
    const now = new Date();
    expect(isDueNow(row({ scheduleKind: 'cron', cronExpr: 'not a cron' }), now)).toBe(false);
  });
});

// ---- Hourly --------------------------------------------------------------
//
// 'hourly' shares storage and slot-math with 'interval' — the test set
// covers the new presentation but stays light because the interval
// suite already exercises the underlying math.

describe('isDueNow (hourly)', () => {
  it('is due at the chosen minute-of-hour when never run', () => {
    // Anchor at today 00:15, every 6 hours → slots at 00:15, 06:15, 12:15, 18:15.
    const anchorAt = new Date();
    anchorAt.setHours(0, 15, 0, 0);
    const now = new Date();
    now.setHours(12, 15, 0, 0);
    expect(isDueNow(row({ scheduleKind: 'hourly', anchorAt, intervalMinutes: 360 }), now)).toBe(
      true,
    );
  });

  it('is not due between hourly slots', () => {
    const anchorAt = new Date();
    anchorAt.setHours(0, 15, 0, 0);
    const now = new Date();
    now.setHours(12, 30, 0, 0);
    const ranThisSlot = new Date();
    ranThisSlot.setHours(12, 16, 0, 0);
    expect(
      isDueNow(
        row({
          scheduleKind: 'hourly',
          anchorAt,
          intervalMinutes: 360,
          lastStartedAt: ranThisSlot,
        }),
        now,
      ),
    ).toBe(false);
  });

  it('is due again at the next hourly slot', () => {
    const anchorAt = new Date();
    anchorAt.setHours(0, 15, 0, 0);
    const now = new Date();
    now.setHours(18, 15, 0, 0);
    const ranAtPrevSlot = new Date();
    ranAtPrevSlot.setHours(12, 16, 0, 0);
    expect(
      isDueNow(
        row({
          scheduleKind: 'hourly',
          anchorAt,
          intervalMinutes: 360,
          lastStartedAt: ranAtPrevSlot,
        }),
        now,
      ),
    ).toBe(true);
  });
});

// ---- Daily ---------------------------------------------------------------

describe('isDueNow (daily)', () => {
  it('is due at the anchor time when never run', () => {
    const anchorAt = timeOnly(2, 0);
    const now = timeOnly(2, 0);
    expect(isDueNow(row({ scheduleKind: 'daily', anchorAt }), now)).toBe(true);
  });

  it('is not due before the anchor time when never run today', () => {
    const anchorAt = timeOnly(2, 0);
    const now = timeOnly(1, 0); // 01:00
    // Hasn't run today, but most-recent slot is yesterday 02:00 — and never-run
    // counts as last=0, so technically 0 < yesterday's slot. Result: due.
    expect(isDueNow(row({ scheduleKind: 'daily', anchorAt }), now)).toBe(true);
  });

  it('is not due if it already ran today after the anchor time', () => {
    const anchorAt = timeOnly(2, 0);
    const ranToday = timeOnly(2, 5); // ran at 02:05 today
    const now = timeOnly(12, 0); // looking at noon today
    expect(isDueNow(row({ scheduleKind: 'daily', anchorAt, lastStartedAt: ranToday }), now)).toBe(
      false,
    );
  });

  it('is due again the next day at the anchor time', () => {
    const anchorAt = timeOnly(2, 0);
    const ranYesterday = new Date(timeOnly(2, 5));
    ranYesterday.setDate(ranYesterday.getDate() - 1);
    const now = timeOnly(2, 1); // today 02:01, after the anchor
    expect(
      isDueNow(row({ scheduleKind: 'daily', anchorAt, lastStartedAt: ranYesterday }), now),
    ).toBe(true);
  });
});

// ---- Weekly --------------------------------------------------------------

describe('isDueNow (weekly)', () => {
  it('is due when today is the anchor weekday and we are past the anchor time', () => {
    const anchorAt = timeOnly(2, 0); // weekday = today
    const now = timeOnly(3, 0);
    expect(isDueNow(row({ scheduleKind: 'weekly', anchorAt }), now)).toBe(true);
  });

  it('is not due if last run was within this week after the slot', () => {
    const anchorAt = timeOnly(2, 0);
    const ranThisWeek = timeOnly(2, 5);
    const now = timeOnly(12, 0);
    expect(
      isDueNow(row({ scheduleKind: 'weekly', anchorAt, lastStartedAt: ranThisWeek }), now),
    ).toBe(false);
  });

  it('is due again next week on the same weekday', () => {
    const anchorAt = timeOnly(2, 0);
    const ranLastWeek = new Date(timeOnly(2, 5));
    ranLastWeek.setDate(ranLastWeek.getDate() - 7);
    const now = timeOnly(3, 0);
    expect(
      isDueNow(row({ scheduleKind: 'weekly', anchorAt, lastStartedAt: ranLastWeek }), now),
    ).toBe(true);
  });
});

// ---- Monthly -------------------------------------------------------------

describe('isDueNow (monthly)', () => {
  it('is due when today is the chosen day-of-month and we are past the anchor time', () => {
    const now = new Date(2026, 4, 15, 3, 0, 0, 0); // May 15 2026 03:00 local
    const anchorAt = new Date(2026, 4, 15, 2, 0, 0, 0); // 02:00
    expect(isDueNow(row({ scheduleKind: 'monthly', anchorAt, monthlyDay: '15' }), now)).toBe(true);
  });

  it('is not due before the chosen day this month', () => {
    const now = new Date(2026, 4, 14, 3, 0, 0, 0); // May 14
    const anchorAt = new Date(2026, 4, 1, 2, 0, 0, 0);
    // Last slot was April 15 at 02:00 — never ran, so last=0 < that = due.
    expect(isDueNow(row({ scheduleKind: 'monthly', anchorAt, monthlyDay: '15' }), now)).toBe(true);
  });

  it('is not due if already ran this month after the slot', () => {
    const now = new Date(2026, 4, 20, 3, 0, 0, 0);
    const anchorAt = new Date(2026, 4, 1, 2, 0, 0, 0);
    const ranThisMonth = new Date(2026, 4, 15, 2, 5, 0, 0);
    expect(
      isDueNow(
        row({
          scheduleKind: 'monthly',
          anchorAt,
          monthlyDay: '15',
          lastStartedAt: ranThisMonth,
        }),
        now,
      ),
    ).toBe(false);
  });

  it('honors "last" as the calendar last day of the month', () => {
    // February 2026 has 28 days.
    const now = new Date(2026, 1, 28, 3, 0, 0, 0);
    const anchorAt = new Date(2026, 1, 1, 2, 0, 0, 0);
    expect(isDueNow(row({ scheduleKind: 'monthly', anchorAt, monthlyDay: 'last' }), now)).toBe(
      true,
    );
    // ...and still works for 31-day months — March 31.
    const nowMar = new Date(2026, 2, 31, 3, 0, 0, 0);
    const anchorMar = new Date(2026, 2, 1, 2, 0, 0, 0);
    expect(
      isDueNow(row({ scheduleKind: 'monthly', anchorAt: anchorMar, monthlyDay: 'last' }), nowMar),
    ).toBe(true);
  });
});
