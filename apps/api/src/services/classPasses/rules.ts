// SPDX-License-Identifier: BUSL-1.1
import {
  CLASS_SYNC_ALERT_MINUTES,
  TAP_MAX_START_DAYS,
  tapExpiresAt,
  type ClassPassStatus,
} from '@openaduc/shared';

// The timing of class passes, kept free of I/O: when a pass is made for,
// when a person still not in Entra is looked for again, and what the
// roster says of a pass.

const MINUTE = 60_000;
/** A pass made this close to class, or after it started, starts now. */
const LATE_START_MS = 60_000;
const DAY_MS = 86_400_000;
/** An issued pass is checked again at least this often, and once more shortly before class. */
const RECHECK_MS = DAY_MS;
/** A pass for a class further off than Graph allows is made this long after it's within reach. */
const REACH_MARGIN_MS = 10 * MINUTE;
/** Connect Sync runs every 30 minutes by default: never look less often than this. */
const MAX_SYNC_WAIT_MS = 15 * MINUTE;
/** Close to class, look more often, so a late sync still gets its pass in time. */
const NEAR_CLASS_SYNC_WAIT_MS = 5 * MINUTE;

/**
 * The pass to make for a class, now: one that starts with class, or once
 * class has started, one that starts now and lasts until it ends. Null
 * once class is over.
 */
export function passWindow(
  classStartsAt: Date,
  lifetimeMinutes: number,
  now: Date,
): { startsAt: string | null; lifetimeMinutes: number; late: boolean } | null {
  const ends = tapExpiresAt(classStartsAt, lifetimeMinutes).getTime();
  if (ends <= now.getTime()) return null;
  if (classStartsAt.getTime() > now.getTime() + LATE_START_MS) {
    return { startsAt: classStartsAt.toISOString(), lifetimeMinutes, late: false };
  }
  return {
    startsAt: null,
    lifetimeMinutes: Math.ceil((ends - now.getTime()) / MINUTE),
    late: true,
  };
}

/** When a pass for this class can first be made: TAP_MAX_START_DAYS before it starts. */
export function reachableAt(classStartsAt: Date): Date {
  return new Date(classStartsAt.getTime() - TAP_MAX_START_DAYS * DAY_MS + REACH_MARGIN_MS);
}

/**
 * When to check again that an issued pass's holder may still have it: a
 * day on, or as class draws near (when the alert would), whichever comes
 * first.
 */
export function recheckAt(classStartsAt: Date | null, now: Date): Date {
  const daily = now.getTime() + RECHECK_MS;
  const near = classStartsAt
    ? classStartsAt.getTime() - CLASS_SYNC_ALERT_MINUTES * MINUTE
    : Number.POSITIVE_INFINITY;
  return new Date(near > now.getTime() ? Math.min(daily, near) : daily);
}

/** Whether class starts soon enough that someone still not in Entra is an alert. */
export function nearClass(classStartsAt: Date, now: Date): boolean {
  return classStartsAt.getTime() - now.getTime() <= CLASS_SYNC_ALERT_MINUTES * MINUTE;
}

/**
 * How long to wait before looking for someone Connect Sync hasn't brought
 * yet, after `attempts` looks: doubling from a minute, up to a quarter of
 * an hour, or five minutes once class is near.
 */
export function syncRetryMs(attempts: number, classStartsAt: Date | null, now: Date): number {
  const cap =
    classStartsAt && nearClass(classStartsAt, now) ? NEAR_CLASS_SYNC_WAIT_MS : MAX_SYNC_WAIT_MS;
  return Math.min(cap, MINUTE * 2 ** Math.max(0, attempts - 1));
}

/** How long to wait after something went wrong that may come right by itself. */
export function errorRetryMs(attempts: number): number {
  return Math.min(MAX_SYNC_WAIT_MS, 2 * MINUTE * 2 ** Math.max(0, attempts - 1));
}

/** Entra lists a pass for them other than the one the class made. */
export const passReplaced = (
  live: { id?: string | null | undefined } | null,
  issuedMethodId: string | null,
): boolean => !!live?.id && !!issuedMethodId && live.id !== issuedMethodId;

/** A pass Entra lists that needn't be kept: used, expired, or not the class's. */
export const passSpent = (
  live: {
    id?: string | null | undefined;
    methodUsabilityReason?: string | null | undefined;
  } | null,
  issuedMethodId: string | null,
): boolean =>
  passReplaced(live, issuedMethodId) ||
  live?.methodUsabilityReason === 'OneTimeUsed' ||
  live?.methodUsabilityReason === 'Expired';

/** What Graph says of the pass it holds, as the roster names it. */
export function graphPassStatus(
  live: {
    id?: string | null | undefined;
    methodUsabilityReason?: string | null | undefined;
  } | null,
  issuedMethodId: string | null,
): { status: ClassPassStatus; message: string | null } {
  if (!live) return { status: 'issued', message: 'Entra hasn’t listed it yet.' };
  if (passReplaced(live, issuedMethodId)) {
    return {
      status: 'replaced',
      message: 'Entra holds another pass for them: it was replaced outside the class roster.',
    };
  }
  switch (live.methodUsabilityReason) {
    case 'NotYetValid':
      return { status: 'notYetValid', message: null };
    case 'EnabledByPolicy':
      return { status: 'usable', message: null };
    case 'OneTimeUsed':
      return { status: 'used', message: null };
    case 'Expired':
      return { status: 'expired', message: null };
    case 'DisabledByPolicy':
      return {
        status: 'issued',
        message: 'The tenant’s authentication methods policy has turned Temporary Access Pass off.',
      };
    default:
      return { status: 'issued', message: null };
  }
}

/** What the roster says of an issued pass when Graph can't be asked: what its times say. */
export function timedPassStatus(
  pass: { startsAt: Date; expiresAt: Date },
  now: Date,
): ClassPassStatus {
  if (pass.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (pass.startsAt.getTime() > now.getTime()) return 'notYetValid';
  return 'issued';
}
