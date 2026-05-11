// SPDX-License-Identifier: BUSL-1.1
import { CronExpressionParser } from 'cron-parser';

/** Result of validating a cron expression supplied by an operator. */
export interface CronValidation {
  ok: boolean;
  /** Error message when ok=false. */
  error?: string;
}

/**
 * Validate a 5-field cron expression. Returns ok=true when cron-parser
 * can fully parse it. Empty/whitespace input is rejected as invalid.
 */
export function validateCron(expr: string): CronValidation {
  const trimmed = expr.trim();
  if (!trimmed) return { ok: false, error: 'cron expression is empty' };
  try {
    CronExpressionParser.parse(trimmed);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'invalid cron expression',
    };
  }
}

/**
 * Most recent scheduled time at or before `now`. Returns null when the
 * expression is invalid (caller should already have validated).
 */
export function previousCronSlot(expr: string, now: Date): Date | null {
  try {
    const iter = CronExpressionParser.parse(expr, { currentDate: now });
    return iter.prev().toDate();
  } catch {
    return null;
  }
}

/**
 * Next scheduled time strictly after `now`.
 */
export function nextCronSlot(expr: string, now: Date): Date | null {
  try {
    const iter = CronExpressionParser.parse(expr, { currentDate: now });
    return iter.next().toDate();
  } catch {
    return null;
  }
}
