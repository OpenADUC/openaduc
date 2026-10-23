// SPDX-License-Identifier: BUSL-1.1
// An account expiry as the operator thinks of it: the last day it works.

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

export function expiryText(expiresAt: string | null): string {
  return expiresAt
    ? `expires at the end of ${lastDayOf(expiresAt).toLocaleDateString()}`
    : 'never expires';
}
