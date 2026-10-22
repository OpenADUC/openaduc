// SPDX-License-Identifier: BUSL-1.1
import type { UserDeleteBlockReason } from '@openaduc/shared';

export interface DeletionCandidate {
  enabled: boolean;
  sid: string | null;
  rawAttributes: Record<string, unknown>;
}

// AD creates its own accounts (Administrator 500, Guest 501, krbtgt 502,
// DefaultAccount 503, WDAGUtilityAccount 504, ...) with RIDs below 1000.
// Several of them are disabled out of the box, so "delete every disabled
// account" would otherwise sweep them up.
const FIRST_NON_BUILTIN_RID = 1000;

/**
 * Why this account must not be deleted, or null when it may be. Shared by
 * the preflight (reading the cache) and the provider (reading the live
 * entry right before the delete).
 */
export function userDeleteBlockReason(user: DeletionCandidate): UserDeleteBlockReason | null {
  if (user.enabled) return 'enabled';
  if (rawFlag(user.rawAttributes['isCriticalSystemObject'])) return 'critical_system_object';
  const rid = ridOf(user.sid);
  if (rid !== null && rid < FIRST_NON_BUILTIN_RID) return 'builtin_account';
  return null;
}

export function describeDeleteBlock(reason: UserDeleteBlockReason): string {
  switch (reason) {
    case 'enabled':
      return 'only disabled accounts can be deleted; disable it first';
    case 'critical_system_object':
      return 'AD marks this account as a critical system object';
    case 'builtin_account':
      return 'this is one of the accounts AD creates for itself';
    case 'not_found':
      return 'user not found';
  }
}

function ridOf(sid: string | null): number | null {
  if (!sid) return null;
  const last = sid.slice(sid.lastIndexOf('-') + 1);
  const rid = Number.parseInt(last, 10);
  return Number.isFinite(rid) ? rid : null;
}

function rawFlag(v: unknown): boolean {
  const value = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof value === 'string' ? value.toUpperCase() === 'TRUE' : value === true;
}
