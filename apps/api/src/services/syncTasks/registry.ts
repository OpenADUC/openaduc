// SPDX-License-Identifier: BUSL-1.1
import type { SyncTaskKey, TaskDefinition } from './types.js';
import { runUsersLocked } from './runners/usersLocked.js';
import { runUsersDelta } from './runners/usersDelta.js';
import { runUsersFull } from './runners/usersFull.js';
import { runGroupsDelta } from './runners/groupsDelta.js';
import { runGroupsFull } from './runners/groupsFull.js';
import { runComputersDelta } from './runners/computersDelta.js';
import { runComputersFull } from './runners/computersFull.js';
import { runOusFull } from './runners/ousFull.js';
import { runGroupPoliciesFull } from './runners/groupPoliciesFull.js';
import { runMembershipsRebuild } from './runners/membershipsRebuild.js';
import { runDomainPolicy } from './runners/domainPolicy.js';
import { runEntraPhotosRefresh } from './runners/entraPhotosRefresh.js';
import { runEntraSignInActivity } from './runners/entraSignInActivity.js';
import { runEntraSignInsEvents } from './runners/entraSignInsEvents.js';
import { runEntraMfaRegistration } from './runners/entraMfaRegistration.js';
import { runEntraPasswordExpiryNotify } from './runners/entraPasswordExpiryNotify.js';

// In-code registry of every known task. The DB stores per-directory
// overrides (cadence, anchor, enabled), but the runner, default cadence,
// priority, and whether to seed-by-default live here.
//
// Lower priority runs first when multiple tasks for the same directory
// are due in the same tick. The picker only runs ONE task per directory
// per tick, so priority matters when the lockout poll and a daily full
// happen to come due at the same minute.
export const TASK_REGISTRY: Record<SyncTaskKey, TaskDefinition> = {
  'users.locked': {
    key: 'users.locked',
    label: 'Locked users',
    defaultIntervalMinutes: 5,
    priority: 10,
    seedByDefault: true,
    watchdogMinutes: 5,
    notifyAfterFailures: 6, // ~30 min of failure at 5-min cadence
    runner: runUsersLocked,
  },
  'users.delta': {
    key: 'users.delta',
    label: 'User changes',
    defaultIntervalMinutes: 15,
    priority: 20,
    seedByDefault: true,
    watchdogMinutes: 15,
    notifyAfterFailures: 4, // ~1h
    runner: runUsersDelta,
  },
  'groups.delta': {
    key: 'groups.delta',
    label: 'Group changes',
    defaultIntervalMinutes: 30,
    priority: 25,
    seedByDefault: true,
    watchdogMinutes: 15,
    notifyAfterFailures: 4,
    runner: runGroupsDelta,
  },
  'computers.delta': {
    key: 'computers.delta',
    label: 'Computer changes',
    defaultIntervalMinutes: 30,
    priority: 27,
    seedByDefault: true,
    watchdogMinutes: 15,
    notifyAfterFailures: 4,
    runner: runComputersDelta,
  },
  'memberships.rebuild': {
    key: 'memberships.rebuild',
    label: 'Memberships',
    defaultIntervalMinutes: 30,
    priority: 30,
    seedByDefault: true,
    watchdogMinutes: 10,
    notifyAfterFailures: 4,
    runner: runMembershipsRebuild,
  },
  'domain.policy': {
    key: 'domain.policy',
    label: 'Domain policy',
    defaultIntervalMinutes: 360, // 6h
    priority: 40,
    seedByDefault: true,
    watchdogMinutes: 5,
    notifyAfterFailures: 3,
    runner: runDomainPolicy,
  },
  'users.full': {
    key: 'users.full',
    label: 'Users (full sync)',
    defaultIntervalMinutes: 1440, // 24h
    priority: 50,
    seedByDefault: true,
    watchdogMinutes: 60,
    notifyAfterFailures: 2, // two missed days = notify
    runner: runUsersFull,
  },
  'groups.full': {
    key: 'groups.full',
    label: 'Groups (full sync)',
    defaultIntervalMinutes: 1440,
    priority: 55,
    seedByDefault: true,
    watchdogMinutes: 60,
    notifyAfterFailures: 2,
    runner: runGroupsFull,
  },
  'computers.full': {
    key: 'computers.full',
    label: 'Computers (full sync)',
    defaultIntervalMinutes: 1440,
    priority: 57,
    seedByDefault: true,
    watchdogMinutes: 60,
    notifyAfterFailures: 2,
    runner: runComputersFull,
  },
  'ous.full': {
    key: 'ous.full',
    label: 'OUs',
    defaultIntervalMinutes: 10080, // 7d
    priority: 60,
    seedByDefault: true,
    watchdogMinutes: 30,
    notifyAfterFailures: 2,
    runner: runOusFull,
  },
  'policies.full': {
    key: 'policies.full',
    label: 'Group Policies',
    // Daily — GPOs change rarely (operator edits in GPMC), but we want the
    // OU browser to reflect newly-linked policies the day after, not the
    // week after. Two LDAP queries per run; cheap on any DC.
    defaultIntervalMinutes: 1440,
    priority: 62,
    seedByDefault: true,
    watchdogMinutes: 15,
    notifyAfterFailures: 2,
    runner: runGroupPoliciesFull,
  },
  // Tombstones is operator-opt-in. The runner exists conceptually but
  // for v1 we leave it unwired — the ad-hoc Deleted Users page covers
  // the use case the operator needs today.
  tombstones: {
    key: 'tombstones',
    label: 'Tombstones',
    defaultIntervalMinutes: 1440,
    priority: 70,
    seedByDefault: false,
    watchdogMinutes: 30,
    notifyAfterFailures: 3,
    runner: async () => ({
      stats: { note: 'tombstones runner not implemented in v1' },
    }),
  },

  // ---- Entra-side tasks ------------------------------------------------
  // These are seeded by default but require an enabled Entra integration
  // on the directory before the scheduler will pick them up. The
  // requires.entra flag tells the picker to skip them when the
  // integration isn't configured — they'll still appear in the sync
  // tasks UI so operators can see what's available.

  'entra.photos.refresh': {
    key: 'entra.photos.refresh',
    label: 'Photos (Graph)',
    defaultIntervalMinutes: 1440, // daily
    priority: 80,
    seedByDefault: true,
    watchdogMinutes: 30,
    notifyAfterFailures: 3,
    requires: { entra: true },
    runner: runEntraPhotosRefresh,
  },
  'entra.signin.activity': {
    key: 'entra.signin.activity',
    label: 'Sign-in activity (Graph)',
    defaultIntervalMinutes: 360, // 6h
    priority: 82,
    seedByDefault: true,
    watchdogMinutes: 30,
    notifyAfterFailures: 3,
    requires: { entra: true },
    runner: runEntraSignInActivity,
  },
  'entra.signins.events': {
    key: 'entra.signins.events',
    label: 'Sign-in events (Graph)',
    defaultIntervalMinutes: 15, // delta pull every 15 min
    priority: 83,
    seedByDefault: true,
    watchdogMinutes: 20,
    notifyAfterFailures: 4, // ~1h of failure
    requires: { entra: true },
    runner: runEntraSignInsEvents,
  },
  'entra.mfa.registration': {
    key: 'entra.mfa.registration',
    label: 'MFA registration (Graph)',
    defaultIntervalMinutes: 10080, // 7d — registration changes rarely
    priority: 84,
    seedByDefault: true,
    watchdogMinutes: 30,
    notifyAfterFailures: 2,
    requires: { entra: true },
    runner: runEntraMfaRegistration,
  },
  'entra.password-expiry.notify': {
    key: 'entra.password-expiry.notify',
    label: 'Password-expiry notifications',
    defaultIntervalMinutes: 1440, // daily
    priority: 85,
    seedByDefault: true,
    watchdogMinutes: 10,
    notifyAfterFailures: 3,
    requires: { entra: true },
    runner: runEntraPasswordExpiryNotify,
  },
};

export const TASK_KEYS = Object.keys(TASK_REGISTRY) as SyncTaskKey[];

export function isKnownTaskKey(key: string): key is SyncTaskKey {
  return Object.prototype.hasOwnProperty.call(TASK_REGISTRY, key);
}

export interface SeedingContext {
  /** Whether the directory has an enabled Entra integration with a stored
   *  client secret. Entra-side tasks are skipped from initial seeding
   *  when this is false so the Tasks UI stays free of rows the operator
   *  hasn't opted into. The seeder is re-run after the integration is
   *  configured to backfill them. */
  hasEntra?: boolean;
}

/**
 * Tasks the lazy-seeder should insert when first encountering a
 * directory. Filters by integration availability so the operator
 * doesn't see Entra rows in the Tasks UI before the integration
 * exists — those tasks land later, when entra is configured.
 */
export function tasksToSeed(ctx: SeedingContext = {}): TaskDefinition[] {
  return TASK_KEYS.map((k) => TASK_REGISTRY[k]).filter((t) => {
    if (!t.seedByDefault) return false;
    if (t.requires?.entra && !ctx.hasEntra) return false;
    return true;
  });
}

/** Task keys that are gated on the Entra integration. Used by the
 *  cleanup path when an integration is removed. */
export const ENTRA_TASK_KEYS: SyncTaskKey[] = TASK_KEYS.filter(
  (k) => TASK_REGISTRY[k].requires?.entra === true,
);
