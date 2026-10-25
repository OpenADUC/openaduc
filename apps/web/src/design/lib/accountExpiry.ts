// SPDX-License-Identifier: BUSL-1.1
// An account expiry as the operator thinks of it: the last day it works.
import { fmtAbsolute } from './format.js';

/**
 * The expiry that lets the account work through `day` (a local calendar
 * day): the midnight that ends it, as ADUC's "End of" writes it.
 */
export function expiryAtEndOf(day: Date): string {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString();
}

/** The last local calendar day an account with this expiry works. */
export function lastDayOf(expiresAt: string): Date {
  const last = new Date(Date.parse(expiresAt) - 1);
  return new Date(last.getFullYear(), last.getMonth(), last.getDate());
}

/**
 * When an account with this expiry stops working, to follow "at": the end
 * of its last day when it expires at local midnight (as ADUC and OpenADUC
 * write it), else the exact time another tool set.
 */
export function expiryMoment(expiresAt: string): string {
  const d = new Date(expiresAt);
  const midnight =
    d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  return midnight ? `the end of ${lastDayOf(expiresAt).toLocaleDateString()}` : fmtAbsolute(d);
}

/** "expires at …" or "never expires"; `capital` starts it with a capital. */
export function expiryText(expiresAt: string | null, capital = false): string {
  const text = expiresAt ? `expires at ${expiryMoment(expiresAt)}` : 'never expires';
  return capital ? text[0]!.toUpperCase() + text.slice(1) : text;
}
