// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../../db/types.js';
import type { DirectoryProvider } from '../../providers/types.js';
import type { EntraIntegrationSummary } from '../entraIntegration.js';
import type { GraphClient } from '../graphClient.js';
import type { PhotoCacheService } from '../photoCache.js';
import type { TeamsNotifierService } from '../teamsNotifier.js';

/**
 * Stable list of task keys. The registry validates that every defined
 * task uses one of these strings, and the DB stores the same string in
 * `directory_sync_tasks.task_key`. Adding a new key here is the first
 * step of adding a task.
 *
 * Task naming: ad-side tasks omit the prefix ('users.delta'); entra-side
 * tasks namespace under 'entra.*' so a glance at the registry tells you
 * which integration each one talks to.
 */
export type SyncTaskKey =
  | 'users.locked'
  | 'users.delta'
  | 'users.full'
  | 'groups.delta'
  | 'groups.full'
  | 'computers.delta'
  | 'computers.full'
  | 'ous.full'
  | 'policies.full'
  | 'memberships.rebuild'
  | 'domain.policy'
  | 'tombstones'
  | 'entra.photos.refresh'
  | 'entra.signin.activity'
  | 'entra.signins.events'
  | 'entra.mfa.registration'
  | 'entra.password-expiry.notify';

/**
 * Schedule kinds. Each interprets the row's anchor_at/interval_minutes/
 * monthly_day differently — see the type definitions and the
 * isDueNow/computeNextDueAt implementations.
 *
 * 'hourly' shares storage with 'interval' (interval_minutes = N*60,
 * anchor_at = some date at 00:MM) but the UI renders it as "every N
 * hours at :MM" instead of "every N*60 min". Same slot math; different
 * presentation.
 */
export type ScheduleKind = 'interval' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

export const SCHEDULE_KINDS: readonly ScheduleKind[] = [
  'interval',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'cron',
];

export function isScheduleKind(value: string): value is ScheduleKind {
  return (SCHEDULE_KINDS as readonly string[]).includes(value);
}

/**
 * Day-of-month sentinel used by the monthly schedule. '1'..'28' are
 * literal days; 'last' is the calendar-aware "last day of the current
 * month". We don't accept 29-31 to dodge ambiguity in short months.
 */
export type MonthlyDay = string; // '1'..'28' | 'last'

export function isMonthlyDay(value: string): boolean {
  if (value === 'last') return true;
  if (!/^[0-9]+$/.test(value)) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 28;
}

export interface RunnerContext {
  db: Kysely<DB>;
  provider: DirectoryProvider;
  providerId: number;
  log: FastifyBaseLogger;
  /** Previous cursor stored on the task row. Opaque to the scheduler. */
  lastCursor: string | null;
  /** Effective cadence (minutes). Used by tasks like tombstones whose
   *  query window equals the cadence. */
  intervalMinutes: number;
  /** Used by *.delta runners to compute `modifiedSince`. */
  lastSuccessfulRunAt: Date | null;
  /**
   * Entra runtime — non-null only for tasks declared with
   * `requires.entra = true`. The scheduler resolves these before invoking
   * the runner, so entra runners can assume non-null and assert if it's
   * missing rather than handling the absent case at every call site.
   */
  entra?: EntraRunnerRuntime;
}

export interface EntraRunnerRuntime {
  graph: GraphClient;
  integration: EntraIntegrationSummary;
  photos: PhotoCacheService;
  teams: TeamsNotifierService;
}

export interface RunnerResult {
  /** New cursor to persist. Undefined = leave the existing one. */
  cursor?: string | null;
  /** Telemetry stored as `last_stats_json`. */
  stats?: Record<string, unknown>;
  /** Other task keys to mark "due now" after this one succeeds. */
  triggers?: SyncTaskKey[];
}

export type RunnerFn = (ctx: RunnerContext) => Promise<RunnerResult>;

export interface TaskRequirements {
  /**
   * False = task does NOT need an AD sync service account. Default
   * (undefined or true) keeps the back-compat behavior where every task
   * needs sync_bind_upn/secret on the directory.
   */
  adSync?: boolean;
  /**
   * True = task needs an enabled Entra integration (with stored client
   * secret) on the directory. Scheduler resolves the runtime and skips
   * the task otherwise.
   */
  entra?: boolean;
}

export interface TaskDefinition {
  key: SyncTaskKey;
  /** Human-readable label for the UI. */
  label: string;
  /** Default cadence when the row's `interval_minutes` is null. */
  defaultIntervalMinutes: number;
  /** Lower = higher priority within a directory. */
  priority: number;
  /**
   * When true, the lazy-seeder inserts a row for this task on first
   * encounter of a directory. False = operator must opt in.
   */
  seedByDefault: boolean;
  /**
   * Watchdog cap. A row stuck in `running` longer than this (and not
   * currently in-flight in this process) is reset to `failed` by the
   * scheduler tick. Long-running fulls get a higher cap.
   */
  watchdogMinutes: number;
  /** Notify dispatcher when `consecutive_failures` crosses this. */
  notifyAfterFailures: number;
  /**
   * Per-integration prerequisites the scheduler enforces. Omitted = AD
   * sync only (current behavior for every legacy task).
   */
  requires?: TaskRequirements;
  runner: RunnerFn;
}
