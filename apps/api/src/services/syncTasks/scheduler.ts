// SPDX-License-Identifier: BUSL-1.1
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import type { DirectoryConfigService } from '../directoryConfig.js';
import type { ProviderFactory } from '../../providers/registry.js';
import { TASK_REGISTRY, isKnownTaskKey } from './registry.js';
import { previousCronSlot } from './cron.js';
import { SyncTaskService, type SyncTaskRow } from './service.js';
import type { NotificationDispatcher, SyncEvent } from './notifications.js';
import type { EntraIntegrationService, EntraIntegrationSummary } from '../entraIntegration.js';
import type { GraphClientFactory } from '../graphClient.js';
import type { PhotoCacheService } from '../photoCache.js';
import type { TeamsNotifierService } from '../teamsNotifier.js';
import type { EntraRunnerRuntime, SyncTaskKey } from './types.js';

/**
 * Result of an inline `runOnce` invocation. Mirrors what the periodic
 * tick persists to the DB but bubbles back to the caller so the
 * onboarding wizard can surface a per-step pass/fail summary instead of
 * polling the sync-task table.
 */
export interface RunOnceResult {
  ok: boolean;
  error?: string;
  stats?: Record<string, unknown> | null;
}

/**
 * Per-directory, per-task scheduler. Replaces the single-interval sync
 * loop. Reuses the original invariants: one in-flight job per
 * directory at a time, multiple directories run in parallel.
 *
 * Tick cadence is unchanged at 60s — fine for a 5-minute minimum task
 * cadence.
 */
export class SyncTaskScheduler {
  private readonly inFlight = new Set<string>(); // `${providerId}:${taskKey}`
  private readonly inFlightByDirectory = new Set<number>();
  /** Tasks the scheduler should treat as immediately due, regardless of cadence.
   *  Populated by `triggerNow` and by runner-returned triggers. */
  private readonly forced = new Map<number, Set<SyncTaskKey>>();
  private readonly tasks: SyncTaskService;
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly tickIntervalMs = 60_000;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly directoryConfig: DirectoryConfigService,
    private readonly providers: ProviderFactory,
    private readonly notifier: NotificationDispatcher,
    private readonly logger: FastifyBaseLogger,
    /**
     * Entra-side dependencies. Optional so test harnesses that don't
     * exercise the integration can build the scheduler with `undefined`
     * and have the requires-entra filter skip every entra task.
     */
    private readonly entra?: {
      integration: EntraIntegrationService;
      graph: GraphClientFactory;
      photos: PhotoCacheService;
      teams: TeamsNotifierService;
    },
  ) {
    this.tasks = new SyncTaskService(db);
  }

  start(): void {
    if (this.tickHandle) return;
    void this.tick();
    this.tickHandle = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.tickHandle.unref?.();
    this.logger.info('sync task scheduler started');
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** True when the periodic tick is currently running. */
  isRunning(): boolean {
    return this.tickHandle !== null;
  }

  /**
   * Public surface used by the API route. Sets the forced flag and kicks
   * an immediate tick so the operator sees the run start within seconds
   * instead of waiting up to 60s for the next periodic tick. The tick is
   * fire-and-forget — we don't run inline so a burst of clicks doesn't
   * spawn parallel runs against the same DC.
   */
  triggerNow(providerId: number, taskKey: SyncTaskKey): { queued: boolean; reason?: string } {
    if (!isKnownTaskKey(taskKey)) return { queued: false, reason: 'unknown task' };
    const set = this.forced.get(providerId) ?? new Set<SyncTaskKey>();
    set.add(taskKey);
    this.forced.set(providerId, set);
    // Wake the scheduler. Safe to call even if a tick is currently
    // running — runTask gates on inFlightByDirectory so the forced task
    // just lands on the next available tick instead.
    if (this.tickHandle) void this.tick();
    return { queued: true };
  }

  /**
   * Snapshot of in-flight + queued tasks per directory. Drives the
   * "Queue" UI surface so the operator can see what's pending without
   * waiting for the scheduler to pick it up.
   */
  inspectQueue(): {
    inFlight: { providerId: number; taskKey: SyncTaskKey }[];
    forced: { providerId: number; taskKey: SyncTaskKey }[];
  } {
    const inFlight: { providerId: number; taskKey: SyncTaskKey }[] = [];
    for (const key of this.inFlight) {
      const sep = key.indexOf(':');
      if (sep < 0) continue;
      const providerId = Number(key.slice(0, sep));
      const taskKey = key.slice(sep + 1) as SyncTaskKey;
      if (!Number.isFinite(providerId)) continue;
      inFlight.push({ providerId, taskKey });
    }
    const forced: { providerId: number; taskKey: SyncTaskKey }[] = [];
    for (const [providerId, keys] of this.forced.entries()) {
      for (const taskKey of keys) {
        forced.push({ providerId, taskKey });
      }
    }
    return { inFlight, forced };
  }

  /**
   * Run a single task to completion inline. Used by the first-run
   * onboarding wizard, which needs to drive a sequence of full syncs
   * with live progress in front of the operator. Bypasses cadence
   * checks but still goes through the same lock + DB-recording pipeline
   * the periodic tick uses, so the run shows up in sync history.
   *
   * Caller is expected to `stop()` the scheduler first when sequencing
   * multiple tasks for the same directory (otherwise an unrelated tick
   * could grab the per-directory slot between two awaits).
   */
  async runOnce(providerId: number, taskKey: SyncTaskKey): Promise<RunOnceResult> {
    if (!isKnownTaskKey(taskKey)) {
      return { ok: false, error: `unknown task: ${String(taskKey)}` };
    }
    return this.runTask(providerId, taskKey);
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date();

      // Lazy-seed: walk every configured directory and ensure its task
      // rows exist. Cheap thanks to the unique index — one SELECT per
      // directory per minute. Pre-task-split cadences are migrated by
      // 20260509000005_drop_legacy_sync_columns; the seeder here only
      // adds rows for task keys the registry has gained since the last
      // run.
      const directories = await this.directoryConfig.listAll();
      // Per-tick entra integration cache so requires-entra filtering
      // doesn't do an N-queries-per-tick fan-out across directories.
      // Empty when the scheduler was built without entra deps.
      const entraByProvider = this.entra
        ? await this.loadEntraSummaries(directories.map((d) => d.id))
        : new Map<number, EntraIntegrationSummary>();
      for (const dir of directories) {
        if (!dir.configured) continue;
        const integration = entraByProvider.get(dir.id);
        const hasEntra = !!integration && integration.enabled && integration.hasClientSecret;
        await this.tasks
          .ensureSeeded(dir.id, { hasEntra })
          .catch((err) => this.logger.warn({ err, directoryId: dir.id }, 'task seed failed'));
      }

      // Watchdog: reset rows stuck in `running` past their per-task
      // watchdogMinutes. We never reset rows we currently own — that
      // would race with this process's runOne.
      const allEnabled = await this.tasks.listAllEnabled();
      for (const { providerId, row } of allEnabled) {
        if (row.lastStatus !== 'running') continue;
        if (this.inFlightKeyHeld(providerId, row.taskKey)) continue;
        const def = TASK_REGISTRY[row.taskKey];
        const startedMs = row.lastStartedAt?.getTime() ?? 0;
        if (startedMs && now.getTime() - startedMs > def.watchdogMinutes * 60_000) {
          await this.tasks
            .resetStuck(
              providerId,
              row.taskKey,
              `watchdog: did not finish within ${def.watchdogMinutes} minutes`,
            )
            .catch((err) =>
              this.logger.warn({ err, providerId, taskKey: row.taskKey }, 'watchdog reset failed'),
            );
        }
      }

      // entraByProvider was loaded above; reuse it for the picker so we
      // don't fan out a second round of integration lookups.

      // Pick at most one task per directory this tick. Highest-priority
      // due task wins; forced tasks are treated as due regardless of
      // cadence. Skip directories without the prerequisites the task
      // declares — the operator sees the integration state on the
      // directory card, no need to spam task rows with "not configured"
      // failures.
      const dueByDirectory = this.pickDueTasks(allEnabled, now);
      for (const [providerId, taskKey] of dueByDirectory.entries()) {
        if (this.inFlightByDirectory.has(providerId)) continue;
        const dir = directories.find((d) => d.id === providerId);
        if (!dir || !dir.configured) continue;
        const def = TASK_REGISTRY[taskKey];
        const needsAdSync = def.requires?.adSync !== false;
        if (needsAdSync && (!dir.syncBindUpn || !dir.hasSyncBindPassword)) continue;
        if (def.requires?.entra) {
          const integration = entraByProvider.get(providerId);
          if (!integration || !integration.enabled || !integration.hasClientSecret) {
            continue;
          }
        }
        void this.runTask(providerId, taskKey).catch((err) =>
          this.logger.error({ err, providerId, taskKey }, 'task run threw'),
        );
        // Note: runTask returns a result; the tick fires-and-forgets so
        // a slow task doesn't hold the tick. runOnce awaits the same
        // promise to read the result.
      }
    } catch (err) {
      this.logger.error({ err }, 'sync scheduler tick failed');
    }
  }

  /**
   * Load all configured entra integrations as a Map keyed by providerId.
   * Called once per tick so requires-entra filtering doesn't fan out
   * into N database queries when many directories are present.
   */
  private async loadEntraSummaries(
    providerIds: number[],
  ): Promise<Map<number, EntraIntegrationSummary>> {
    if (!this.entra || providerIds.length === 0) {
      return new Map();
    }
    const result = new Map<number, EntraIntegrationSummary>();
    // The integration table is small (one row per directory at most),
    // so a fanout of getByProviderId is fine here. If/when this grows,
    // swap to a single SELECT IN (...) query.
    for (const id of providerIds) {
      const row = await this.entra.integration.getByProviderId(id);
      if (row) result.set(id, row);
    }
    return result;
  }

  private inFlightKey(providerId: number, taskKey: SyncTaskKey): string {
    return `${providerId}:${taskKey}`;
  }

  private inFlightKeyHeld(providerId: number, taskKey: SyncTaskKey): boolean {
    return this.inFlight.has(this.inFlightKey(providerId, taskKey));
  }

  /**
   * Returns directoryId -> taskKey map of which task should run this
   * tick. Forced (operator-clicked "Run now") tasks beat cadence-due
   * tasks regardless of priority — otherwise a low-priority cadence
   * task running on every tick (users.locked at 5min, priority 10)
   * would starve a manually-triggered high-priority entra task at
   * priority 80. Among forced peers (or, if no forced, among
   * cadence-due peers) the lowest priority number wins.
   */
  private pickDueTasks(
    allEnabled: { providerId: number; row: SyncTaskRow }[],
    now: Date,
  ): Map<number, SyncTaskKey> {
    interface Candidate {
      taskKey: SyncTaskKey;
      priority: number;
      forced: boolean;
    }
    const candidates = new Map<number, Candidate>();
    for (const { providerId, row } of allEnabled) {
      const def = TASK_REGISTRY[row.taskKey];
      const forced = this.forced.get(providerId)?.has(row.taskKey) ?? false;
      const dueByCadence = isDueNow(row, now);
      if (!forced && !dueByCadence) continue;

      const existing = candidates.get(providerId);
      // Forced wins outright. If neither or both are forced, lower
      // priority number wins.
      const better =
        !existing ||
        (forced && !existing.forced) ||
        (forced === existing.forced && def.priority < existing.priority);
      if (better) {
        candidates.set(providerId, { taskKey: row.taskKey, priority: def.priority, forced });
      }
    }
    return new Map([...candidates].map(([k, v]) => [k, v.taskKey]));
  }

  private async runTask(providerId: number, taskKey: SyncTaskKey): Promise<RunOnceResult> {
    const inFlightKey = this.inFlightKey(providerId, taskKey);
    if (this.inFlight.has(inFlightKey)) {
      return { ok: false, error: 'task already running for this directory' };
    }
    if (this.inFlightByDirectory.has(providerId)) {
      return { ok: false, error: 'another task is running for this directory' };
    }
    this.inFlight.add(inFlightKey);
    this.inFlightByDirectory.add(providerId);
    // Snapshot whether this run was operator-forced before clearing the
    // flag. The history row records the trigger so a "Run now → failed"
    // is visually distinct from "scheduler picked it up → failed".
    const forcedTrigger = this.forced.get(providerId)?.has(taskKey) ?? false;
    // Clear the forced flag the moment we pick the task up — a re-trigger
    // mid-run should re-arm for the next tick, not get swallowed.
    this.forced.get(providerId)?.delete(taskKey);

    const def = TASK_REGISTRY[taskKey];
    const log = this.logger.child({ providerId, taskKey });
    let cursor: string | null | undefined;
    let stats: Record<string, unknown> | null | undefined;
    let triggers: SyncTaskKey[] = [];
    let outcome: RunOnceResult = { ok: false, error: 'task did not start' };
    // Declared outside the try so the catch block can close the history
    // row even when the runner throws after markStarted has succeeded.
    let started: { runId: number; startedAt: Date } | null = null;

    try {
      // Every task in v1 implies adSync (entra tasks default
      // requires.adSync to true). The branch on `requires.adSync ===
      // false` exists for forward-compat — if/when an entra-only task
      // lands, this loop will need to handle a null `creds` and a
      // synthesized no-op provider. For now, AD sync creds are always
      // required.
      const creds = await this.directoryConfig.getSyncBindCreds(providerId);
      if (!creds) {
        // Shouldn't happen — tick filters these out — but defend anyway.
        log.warn('sync creds disappeared between picker and runner');
        outcome = { ok: false, error: 'service account credentials missing' };
        return outcome;
      }
      // Resolve the entra runtime up front so individual runners don't
      // have to know how to assemble it. Skip with a logged warning if
      // the integration disappeared between the picker and the runner.
      let entraRuntime: EntraRunnerRuntime | undefined;
      if (def.requires?.entra) {
        if (!this.entra) {
          log.warn('entra task scheduled but scheduler has no entra deps');
          outcome = { ok: false, error: 'entra integration not configured' };
          return outcome;
        }
        const integration = await this.entra.integration.getByProviderId(providerId);
        if (!integration || !integration.enabled || !integration.hasClientSecret) {
          log.warn('entra integration disappeared between picker and runner');
          outcome = { ok: false, error: 'entra integration not configured' };
          return outcome;
        }
        const graph = await this.entra.graph.build(providerId);
        if (!graph) {
          log.warn('entra graph client not buildable');
          outcome = { ok: false, error: 'entra graph client not buildable' };
          return outcome;
        }
        entraRuntime = {
          graph,
          integration,
          photos: this.entra.photos,
          teams: this.entra.teams,
        };
      }

      started = await this.tasks.markStarted(
        providerId,
        taskKey,
        forcedTrigger ? 'forced' : 'cadence',
      );
      log.info(
        { runId: started.runId, trigger: forcedTrigger ? 'forced' : 'cadence' },
        'task started',
      );

      // Read the row again so the runner sees a fresh cursor /
      // lastSuccessfulRunAt — the picker's snapshot may be a tick old.
      const summary = (await this.tasks.listForDirectory(providerId)).find(
        (s) => s.taskKey === taskKey,
      );
      const lastCursor = summary?.lastCursor ?? null;
      const lastFinishedAt = summary?.lastFinishedAt ?? null;
      const intervalMinutes = summary?.intervalMinutes ?? def.defaultIntervalMinutes;

      const provider = await this.providers.buildWithCreds(providerId, creds);
      const result = await def.runner({
        db: this.db,
        provider,
        providerId,
        log,
        lastCursor,
        intervalMinutes,
        // Use last_finished_at — the previous successful run window's end.
        lastSuccessfulRunAt: summary?.lastStatus === 'succeeded' ? lastFinishedAt : null,
        ...(entraRuntime ? { entra: entraRuntime } : {}),
      });
      cursor = result.cursor;
      stats = result.stats ?? null;
      triggers = result.triggers ?? [];

      const finished = await this.tasks.markFinished(providerId, taskKey, {
        ok: true,
        cursor,
        stats,
        runId: started?.runId ?? null,
        startedAt: started?.startedAt ?? null,
      });
      log.info({ stats }, 'task finished');
      this.fireNotifications(providerId, taskKey, finished, null);
      outcome = { ok: true, stats: stats ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'task failed');
      const finished = await this.tasks
        .markFinished(providerId, taskKey, {
          ok: false,
          error: message,
          // The history row was opened above — close it here too. If
          // markStarted itself threw before assigning `started`, the
          // outer scope catches the ReferenceError; that's intentional.
          runId: started?.runId ?? null,
          startedAt: started?.startedAt ?? null,
        })
        .catch((markErr) => {
          log.warn({ err: markErr }, 'markFinished failed');
          return null;
        });
      if (finished) this.fireNotifications(providerId, taskKey, finished, message);
      outcome = { ok: false, error: message };
    } finally {
      this.inFlight.delete(inFlightKey);
      this.inFlightByDirectory.delete(providerId);
      // Honor triggers AFTER releasing the directory slot so the next
      // tick can pick them up.
      for (const trig of triggers) {
        this.triggerNow(providerId, trig);
      }
      // If anything else is still in the forced queue for this
      // directory, wake the scheduler so the operator doesn't wait up
      // to 60s for the next periodic tick to drain it.
      const queued = this.forced.get(providerId);
      if (queued && queued.size > 0 && this.tickHandle) {
        void this.tick();
      }
    }
    return outcome;
  }

  private fireNotifications(
    providerId: number,
    taskKey: SyncTaskKey,
    result: {
      consecutiveFailures: number;
      recovered: boolean;
      crossedThreshold: boolean;
      threshold: number;
    },
    error: string | null,
  ): void {
    const at = new Date();
    const events: SyncEvent[] = [];
    if (result.recovered) {
      events.push({
        kind: 'task.recovered',
        providerId,
        taskKey,
        previousFailures: result.consecutiveFailures, // 0 after recovery; threshold caller already knows
        at,
      });
    }
    if (error !== null) {
      events.push({
        kind: 'task.failed',
        providerId,
        taskKey,
        error,
        consecutiveFailures: result.consecutiveFailures,
        at,
      });
    }
    if (result.crossedThreshold && error !== null) {
      events.push({
        kind: 'task.failed_threshold',
        providerId,
        taskKey,
        error,
        consecutiveFailures: result.consecutiveFailures,
        threshold: result.threshold,
        at,
      });
    }
    for (const ev of events) {
      try {
        const maybe = this.notifier.dispatch(ev);
        if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
          (maybe as Promise<unknown>).catch((err) =>
            this.logger.warn({ err, kind: ev.kind }, 'notification dispatch failed'),
          );
        }
      } catch (err) {
        this.logger.warn({ err, kind: ev.kind }, 'notification dispatch threw');
      }
    }
  }
}

/**
 * Pure due-ness check. Exported for unit testing.
 *
 * Per-kind semantics:
 *   'interval' — anchor + N*interval slot in the past AND we haven't
 *     run since that slot, OR (no anchor) elapsed time ≥ interval.
 *   'daily'    — most recent today-at-anchor-time in the past AND we
 *     haven't run since.
 *   'weekly'   — most recent (anchor weekday at anchor time) in the
 *     past AND we haven't run since.
 *   'monthly'  — most recent (this/last month's monthlyDay at anchor
 *     time) in the past AND we haven't run since.
 */
export function isDueNow(row: SyncTaskRow, now: Date): boolean {
  const last = row.lastStartedAt?.getTime() ?? 0;

  switch (row.scheduleKind) {
    // 'hourly' shares storage and slot-math with 'interval'; the
    // operator-facing distinction is purely UI.
    case 'interval':
    case 'hourly': {
      const intervalMs = row.intervalMinutes * 60_000;
      if (intervalMs <= 0) return false;
      if (!row.anchorAt) {
        if (last === 0) return true;
        return now.getTime() - last >= intervalMs;
      }
      const anchorMs = row.anchorAt.getTime();
      if (now.getTime() < anchorMs) return false;
      const slotIdx = Math.floor((now.getTime() - anchorMs) / intervalMs);
      const slotMs = anchorMs + slotIdx * intervalMs;
      return last < slotMs;
    }
    case 'daily': {
      if (!row.anchorAt) return false;
      const slot = mostRecentSlot(now, row.anchorAt, 'daily', null);
      if (!slot || slot.getTime() > now.getTime()) return false;
      return last < slot.getTime();
    }
    case 'weekly': {
      if (!row.anchorAt) return false;
      const slot = mostRecentSlot(now, row.anchorAt, 'weekly', null);
      if (!slot || slot.getTime() > now.getTime()) return false;
      return last < slot.getTime();
    }
    case 'monthly': {
      if (!row.anchorAt || !row.monthlyDay) return false;
      const slot = mostRecentSlot(now, row.anchorAt, 'monthly', row.monthlyDay);
      if (!slot || slot.getTime() > now.getTime()) return false;
      return last < slot.getTime();
    }
    case 'cron': {
      if (!row.cronExpr) return false;
      const slot = previousCronSlot(row.cronExpr, now);
      if (!slot) return false;
      return last < slot.getTime();
    }
  }
}

/**
 * Returns the most recent scheduled slot at-or-before `now` for the
 * given kind. For 'monthly' the slot is calendar-aware ('last' = last
 * day of the current month).
 */
function mostRecentSlot(
  now: Date,
  anchor: Date,
  kind: 'daily' | 'weekly' | 'monthly',
  monthlyDay: string | null,
): Date | null {
  if (kind === 'daily') {
    const today = new Date(now);
    today.setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), 0);
    if (today.getTime() <= now.getTime()) return today;
    today.setDate(today.getDate() - 1);
    return today;
  }
  if (kind === 'weekly') {
    const target = anchor.getDay();
    const slot = new Date(now);
    slot.setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), 0);
    const delta = (slot.getDay() - target + 7) % 7;
    slot.setDate(slot.getDate() - delta);
    if (slot.getTime() > now.getTime()) {
      slot.setDate(slot.getDate() - 7);
    }
    return slot;
  }
  // monthly
  if (!monthlyDay) return null;
  const slot = monthlySlotForMonth(now, monthlyDay, anchor);
  if (slot.getTime() > now.getTime()) {
    return monthlySlotForMonth(addMonths(now, -1), monthlyDay, anchor);
  }
  return slot;
}

function monthlySlotForMonth(monthMarker: Date, monthlyDay: string, time: Date): Date {
  const year = monthMarker.getFullYear();
  const month = monthMarker.getMonth();
  const day = monthlyDay === 'last' ? new Date(year, month + 1, 0).getDate() : Number(monthlyDay);
  return new Date(year, month, day, time.getHours(), time.getMinutes(), time.getSeconds(), 0);
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}
