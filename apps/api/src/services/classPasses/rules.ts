// SPDX-License-Identifier: BUSL-1.1
import { CLASS_SYNC_ALERT_MINUTES, tapExpiresAt, type ClassPassStatus } from '@openaduc/shared';

// The timing of class passes, kept free of I/O: when a pass is made for,
// when a person still not in Entra is looked for again, and what the
// roster says of a pass.

const MINUTE = 60_000;
/** A pass made this close to class, or after it started, starts now. */
const START_SKEW_MS = 60_000;
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
  if (classStartsAt.getTime() > now.getTime() + START_SKEW_MS) {
    return { startsAt: classStartsAt.toISOString(), lifetimeMinutes, late: false };
  }
  return {
    startsAt: null,
    lifetimeMinutes: Math.ceil((ends - now.getTime()) / MINUTE),
    late: true,
  };
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

/** What Graph says of the pass it holds, as the roster names it. */
export function graphPassStatus(
  live: {
    id?: string | null | undefined;
    methodUsabilityReason?: string | null | undefined;
  } | null,
  issuedMethodId: string | null,
): { status: ClassPassStatus; message: string | null } {
  if (!live || (issuedMethodId && live.id && live.id !== issuedMethodId)) {
    return {
      status: 'replaced',
      message:
        'Entra holds another pass for them, or none: it was replaced or deleted outside the class roster.',
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
