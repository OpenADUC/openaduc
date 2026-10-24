// SPDX-License-Identifier: BUSL-1.1
import type { SignInInput } from './signIn.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an account needs attention: enabled, and locked, made to change
 * its password (which AD holds back while it never expires), or with its
 * account or password expiring within `withinDays`. Keep in step with the
 * `issues=true` filter of GET /api/users in apps/api/src/routes/users.ts,
 * which decides the same thing in SQL.
 */
export function needsAttention(u: SignInInput, withinDays: number, now = new Date()): boolean {
  if (u.enabled === false) return false;
  const horizon = now.getTime() + withinDays * DAY_MS;
  const by = (iso: string | null | undefined) => !!iso && Date.parse(iso) <= horizon;
  return (
    !!u.locked ||
    (!!u.passwordMustChange && !u.passwordNeverExpires) ||
    by(u.accountExpiresAt) ||
    (!u.passwordNeverExpires && by(u.passwordExpiresAt))
  );
}
