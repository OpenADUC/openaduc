// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import { TASK_REGISTRY, isKnownTaskKey, tasksToSeed } from './registry.js';
import { nextCronSlot } from './cron.js';
import type { MonthlyDay, ScheduleKind, SyncTaskKey } from './types.js';

/** API/UI-shaped view of a directory_sync_tasks row, with registry data merged in. */
export interface SyncTaskSummary {
  taskKey: SyncTaskKey;
  label: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  /** Effective cadence in minutes. Only meaningful for kind='interval'. */
  intervalMinutes: number;
  /** Registry default cadence in minutes — surfaces the "factory" value for the Reset button. */
  defaultIntervalMinutes: number;
  /** True when the row has its own interval override (kind='interval' only). */
  intervalIsOverride: boolean;
  anchorAt: Date | null;
  /** '1'..'28' or 'last'. Null unless kind='monthly'. */
  monthlyDay: MonthlyDay | null;
  /** 5-field cron expression. Null unless kind='cron'. */
  cronExpr: string | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: 'running' | 'succeeded' | 'failed' | null;
  lastError: string | null;
  lastCursor: string | null;
  lastStats: Record<string, unknown> | null;
  consecutiveFailures: number;
  priority: number;
  /** Computed next slot start. Approximate; surfaced to the UI. */
  nextDueAt: Date | null;
}

export interface SyncTaskRow {
  taskKey: SyncTaskKey;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  intervalMinutes: number;
  anchorAt: Date | null;
  monthlyDay: MonthlyDay | null;
  cronExpr: string | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: 'running' | 'succeeded' | 'failed' | null;
  lastError: string | null;
  lastCursor: string | null;
  lastStats: Record<string, unknown> | null;
  consecutiveFailures: number;
}

export interface SyncTaskPatch {
  enabled?: boolean;
  scheduleKind?: ScheduleKind;
  /** null clears override → falls back to registry default. Only used for kind='interval'. */
  intervalMinutes?: number | null;
  /** null clears the anchor. */
  anchorAt?: Date | null;
  /** Only used for kind='monthly'; null clears. */
  monthlyDay?: MonthlyDay | null;
  /** Only used for kind='cron'; null clears. */
  cronExpr?: string | null;
}

/** Result of `markFinished`, used by the scheduler to decide whether to fire a notification. */
export interface MarkFinishedResult {
  consecutiveFailures: number;
  /** True when this run flipped 0 → ≥1 failures or vice versa. */
  recovered: boolean;
  crossedThreshold: boolean;
  threshold: number;
}

/**
 * DB layer for per-directory sync tasks. Mirrors the shape of the
 * directory_sync_tasks table, merging in registry metadata so callers
 * never need to know about defaults.
 */
export class SyncTaskService {
  constructor(private readonly db: Kysely<DB>) {}

  /**
   * Insert any missing rows for tasks the registry says should be
   * seeded by default. Idempotent — re-running on a directory with
   * existing rows leaves them alone.
   *
   * Pre-task-split installations had their cadence on
   * directory_providers.sync_interval_minutes; the
   * 20260509000005_drop_legacy_sync_columns migration backfills that
   * into directory_sync_tasks.users.full.interval_minutes before the
   * column is dropped, so this seeder only deals with brand-new task
   * keys against existing or newly-created directories.
   */
  async ensureSeeded(providerId: number, opts: { hasEntra?: boolean } = {}): Promise<void> {
    const existing = await this.db
      .selectFrom('directory_sync_tasks')
      .select(['task_key'])
      .where('provider_id', '=', providerId)
      .execute();
    const existingKeys = new Set(existing.map((r) => r.task_key));

    const toInsert: {
      provider_id: number;
      task_key: string;
      enabled: boolean;
      interval_minutes: number | null;
    }[] = [];

    for (const def of tasksToSeed({ hasEntra: opts.hasEntra ?? false })) {
      if (existingKeys.has(def.key)) continue;
      toInsert.push({
        provider_id: providerId,
        task_key: def.key,
        enabled: true,
        interval_minutes: null,
      });
    }

    if (toInsert.length === 0) return;
    await this.db.insertInto('directory_sync_tasks').values(toInsert).execute();
  }

  /**
   * Drop sync_task rows for the given keys. Used by the entra
   * integration delete path so removing the integration also clears the
   * task rows it brought in — otherwise the Tasks UI keeps showing
   * "needs entra" placeholders for keys the operator can't run anymore.
   */
  async removeTasks(providerId: number, keys: SyncTaskKey[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db
      .deleteFrom('directory_sync_tasks')
      .where('provider_id', '=', providerId)
      .where('task_key', 'in', keys)
      .execute();
  }

  /** All task rows for a directory, with registry metadata merged in. */
  async listForDirectory(providerId: number): Promise<SyncTaskSummary[]> {
    const rows = await this.db
      .selectFrom('directory_sync_tasks')
      .selectAll()
      .where('provider_id', '=', providerId)
      .execute();

    const summaries: SyncTaskSummary[] = [];
    for (const row of rows) {
      if (!isKnownTaskKey(row.task_key)) continue; // skip unknown (e.g. removed tasks)
      const def = TASK_REGISTRY[row.task_key];
      const intervalIsOverride =
        row.interval_minutes !== null && row.interval_minutes !== undefined;
      const intervalMinutes = intervalIsOverride
        ? Number(row.interval_minutes)
        : def.defaultIntervalMinutes;
      const anchorAt = row.anchor_at ? new Date(row.anchor_at) : null;
      const scheduleKind = (row.schedule_kind as SyncTaskSummary['scheduleKind']) ?? 'interval';
      const monthlyDay = (row.monthly_day as MonthlyDay | null) ?? null;
      const cronExpr = row.cron_expr ?? null;
      summaries.push({
        taskKey: row.task_key,
        label: def.label,
        enabled: row.enabled,
        scheduleKind,
        intervalMinutes,
        defaultIntervalMinutes: def.defaultIntervalMinutes,
        intervalIsOverride,
        anchorAt,
        monthlyDay,
        cronExpr,
        lastStartedAt: row.last_started_at ? new Date(row.last_started_at) : null,
        lastFinishedAt: row.last_finished_at ? new Date(row.last_finished_at) : null,
        lastStatus: (row.last_status as SyncTaskSummary['lastStatus']) ?? null,
        lastError: row.last_error ?? null,
        lastCursor: row.last_cursor ?? null,
        lastStats: (row.last_stats_json as Record<string, unknown> | null) ?? null,
        consecutiveFailures: row.consecutive_failures,
        priority: def.priority,
        nextDueAt: computeNextDueAt({
          scheduleKind,
          intervalMinutes,
          anchorAt,
          monthlyDay,
          cronExpr,
          lastStartedAt: row.last_started_at ? new Date(row.last_started_at) : null,
        }),
      });
    }

    // Stable order: priority then key.
    summaries.sort((a, b) => a.priority - b.priority || a.taskKey.localeCompare(b.taskKey));
    return summaries;
  }

  /** Light shape for the scheduler's tick. */
  async listAllEnabled(): Promise<{ providerId: number; row: SyncTaskRow }[]> {
    const rows = await this.db
      .selectFrom('directory_sync_tasks')
      .selectAll()
      .where('enabled', '=', true)
      .execute();
    const out: { providerId: number; row: SyncTaskRow }[] = [];
    for (const row of rows) {
      if (!isKnownTaskKey(row.task_key)) continue;
      const def = TASK_REGISTRY[row.task_key];
      out.push({
        providerId: Number(row.provider_id),
        row: {
          taskKey: row.task_key,
          enabled: row.enabled,
          scheduleKind: (row.schedule_kind as ScheduleKind) ?? 'interval',
          intervalMinutes: row.interval_minutes ?? def.defaultIntervalMinutes,
          anchorAt: row.anchor_at ? new Date(row.anchor_at) : null,
          monthlyDay: (row.monthly_day as MonthlyDay | null) ?? null,
          cronExpr: row.cron_expr ?? null,
          lastStartedAt: row.last_started_at ? new Date(row.last_started_at) : null,
          lastFinishedAt: row.last_finished_at ? new Date(row.last_finished_at) : null,
          lastStatus: (row.last_status as SyncTaskRow['lastStatus']) ?? null,
          lastError: row.last_error ?? null,
          lastCursor: row.last_cursor ?? null,
          lastStats: (row.last_stats_json as Record<string, unknown> | null) ?? null,
          consecutiveFailures: row.consecutive_failures,
        },
      });
    }
    return out;
  }

  async update(
    providerId: number,
    taskKey: SyncTaskKey,
    patch: SyncTaskPatch,
  ): Promise<SyncTaskSummary> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.intervalMinutes !== undefined) set.interval_minutes = patch.intervalMinutes;
    if (patch.anchorAt !== undefined) set.anchor_at = patch.anchorAt;
    if (patch.scheduleKind !== undefined) {
      set.schedule_kind = patch.scheduleKind;
      // Switching kind invalidates fields that don't apply. Clear them
      // explicitly so the DB CHECK constraints (and the scheduler) can
      // trust the row shape after the patch lands. interval_minutes is
      // used by both 'interval' and 'hourly' (the latter stores N*60),
      // so only daily/weekly/monthly/cron null it out.
      if (patch.scheduleKind !== 'monthly') set.monthly_day = null;
      if (patch.scheduleKind !== 'cron') set.cron_expr = null;
      if (patch.scheduleKind !== 'interval' && patch.scheduleKind !== 'hourly') {
        set.interval_minutes = null;
      }
    }
    if (patch.monthlyDay !== undefined) set.monthly_day = patch.monthlyDay;
    if (patch.cronExpr !== undefined) set.cron_expr = patch.cronExpr;

    await this.db
      .updateTable('directory_sync_tasks')
      .set(set)
      .where('provider_id', '=', providerId)
      .where('task_key', '=', taskKey)
      .execute();

    const summary = (await this.listForDirectory(providerId)).find((s) => s.taskKey === taskKey);
    if (!summary) {
      throw new Error(`task ${taskKey} not found for directory ${providerId}`);
    }
    return summary;
  }

  /** Operator escape hatch — flip a stuck row out of `running`. */
  async resetStuck(providerId: number, taskKey: SyncTaskKey, reason: string): Promise<void> {
    await this.db
      .updateTable('directory_sync_tasks')
      .set({
        last_status: 'failed',
        last_error: reason,
        last_finished_at: new Date(),
        updated_at: new Date(),
      })
      .where('provider_id', '=', providerId)
      .where('task_key', '=', taskKey)
      .where('last_status', '=', 'running')
      .execute();
  }

  /**
   * Mark a run as started. Updates the latest-status fields on the task
   * row AND opens a new history row that markFinished will close. Returns
   * the new history row's id so the caller can pass it back to
   * markFinished — avoids racy "find the most recent running row" logic.
   */
  async markStarted(
    providerId: number,
    taskKey: SyncTaskKey,
    trigger: 'forced' | 'cadence' = 'cadence',
  ): Promise<{ runId: number; startedAt: Date }> {
    const startedAt = new Date();
    await this.db
      .updateTable('directory_sync_tasks')
      .set({
        last_started_at: startedAt,
        last_finished_at: null,
        last_status: 'running',
        last_error: null,
        updated_at: startedAt,
      })
      .where('provider_id', '=', providerId)
      .where('task_key', '=', taskKey)
      .execute();
    const inserted = await this.db
      .insertInto('directory_sync_task_runs')
      .values({
        provider_id: providerId,
        task_key: taskKey,
        status: 'running',
        started_at: startedAt,
        trigger,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { runId: Number(inserted.id), startedAt };
  }

  async markFinished(
    providerId: number,
    taskKey: SyncTaskKey,
    result: {
      ok: boolean;
      error?: string | null | undefined;
      cursor?: string | null | undefined;
      stats?: Record<string, unknown> | null | undefined;
      /** History-row id from markStarted. When provided, that row is
       *  closed with the final status. Optional so legacy callers / tests
       *  that don't go through markStarted still work. */
      runId?: number | null | undefined;
      /** Started-at returned from markStarted, for accurate duration_ms. */
      startedAt?: Date | null | undefined;
    },
  ): Promise<MarkFinishedResult> {
    // Read the existing failure count so we can detect recovery /
    // threshold-crossing in a single round trip.
    const before = await this.db
      .selectFrom('directory_sync_tasks')
      .select(['consecutive_failures', 'last_status'])
      .where('provider_id', '=', providerId)
      .where('task_key', '=', taskKey)
      .executeTakeFirst();
    const previousFailures = before?.consecutive_failures ?? 0;
    const def = TASK_REGISTRY[taskKey];
    const threshold = def.notifyAfterFailures;

    const nextFailures = result.ok ? 0 : previousFailures + 1;
    const recovered = result.ok && previousFailures > 0;
    const crossedThreshold =
      !result.ok && previousFailures < threshold && nextFailures >= threshold;

    const finishedAt = new Date();
    const set: Record<string, unknown> = {
      last_finished_at: finishedAt,
      last_status: result.ok ? 'succeeded' : 'failed',
      last_error: result.error ?? null,
      consecutive_failures: nextFailures,
      updated_at: finishedAt,
    };
    if (result.cursor !== undefined) set.last_cursor = result.cursor;
    if (result.stats !== undefined) {
      set.last_stats_json = result.stats === null ? null : JSON.stringify(result.stats);
    }

    await this.db
      .updateTable('directory_sync_tasks')
      .set(set)
      .where('provider_id', '=', providerId)
      .where('task_key', '=', taskKey)
      .execute();

    // Close the matching history row, if one was opened. We compute
    // duration_ms here rather than as a generated column so older
    // Postgres versions that don't expose `(finished_at - started_at)`
    // arithmetic in milliseconds don't bite us.
    if (result.runId) {
      const durationMs = result.startedAt
        ? Math.max(0, finishedAt.getTime() - result.startedAt.getTime())
        : null;
      await this.db
        .updateTable('directory_sync_task_runs')
        .set({
          status: result.ok ? 'succeeded' : 'failed',
          finished_at: finishedAt,
          duration_ms: durationMs,
          error: result.error ?? null,
          stats_json:
            result.stats === undefined || result.stats === null
              ? null
              : (JSON.stringify(result.stats) as never),
        })
        .where('id', '=', result.runId)
        .execute();
    }

    return {
      consecutiveFailures: nextFailures,
      recovered,
      crossedThreshold,
      threshold,
    };
  }

  /**
   * Recent runs for a single task, newest first. The default cap of 50
   * is enough to spot a run-storm without paginating; the operator can
   * always run a manual SQL if they need more.
   */
  async listRecentRuns(
    providerId: number,
    taskKey: SyncTaskKey,
    limit = 50,
  ): Promise<TaskRunSummary[]> {
    const rows = await this.db
      .selectFrom('directory_sync_task_runs')
      .where('provider_id', '=', providerId)
      .where('task_key', '=', taskKey)
      .orderBy('started_at', 'desc')
      .limit(Math.min(Math.max(1, limit), 200))
      .selectAll()
      .execute();
    return rows.map((r) => ({
      id: Number(r.id),
      status: r.status as TaskRunSummary['status'],
      trigger: (r.trigger as TaskRunSummary['trigger']) ?? 'cadence',
      startedAt: r.started_at instanceof Date ? r.started_at : new Date(r.started_at),
      finishedAt: r.finished_at
        ? r.finished_at instanceof Date
          ? r.finished_at
          : new Date(r.finished_at)
        : null,
      durationMs: r.duration_ms ?? null,
      error: r.error ?? null,
      stats: (r.stats_json as Record<string, unknown> | null) ?? null,
    }));
  }
}

export interface TaskRunSummary {
  id: number;
  status: 'running' | 'succeeded' | 'failed';
  trigger: 'forced' | 'cadence';
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  stats: Record<string, unknown> | null;
}

/**
 * Compute the next due time for the UI. Pure function.
 *
 * Behavior depends on `scheduleKind`:
 *   - 'interval': next slot = anchor + N*interval, or last+interval if
 *     no anchor. Falls back to "now" when never run + no anchor.
 *   - 'daily':    today's anchor-time-of-day if not yet past,
 *     otherwise tomorrow's.
 *   - 'weekly':   next weekday matching anchor's day-of-week at the
 *     anchor's time-of-day.
 *   - 'monthly':  this month's monthlyDay at the anchor's time-of-day
 *     if not yet past, otherwise next month's.
 *
 * When the result equals `now` to within a second, returns the slot
 * advanced by one interval/day/week/month so the UI doesn't flicker
 * between "now" and "in 1s".
 */
export function computeNextDueAt(input: {
  scheduleKind: ScheduleKind;
  intervalMinutes: number;
  anchorAt: Date | null;
  monthlyDay: MonthlyDay | null;
  cronExpr: string | null;
  lastStartedAt: Date | null;
}): Date | null {
  const now = new Date();

  switch (input.scheduleKind) {
    // 'hourly' shares slot-math with 'interval' (same anchor + N*interval),
    // only the UI text differs.
    case 'interval':
    case 'hourly': {
      const intervalMs = input.intervalMinutes * 60_000;
      if (intervalMs <= 0) return null;

      if (!input.anchorAt) {
        if (!input.lastStartedAt) return now;
        return new Date(input.lastStartedAt.getTime() + intervalMs);
      }
      const anchorMs = input.anchorAt.getTime();
      const elapsedFromAnchor = Math.max(0, now.getTime() - anchorMs);
      const nextSlotIdx = Math.ceil(elapsedFromAnchor / intervalMs);
      const candidate = new Date(anchorMs + nextSlotIdx * intervalMs);
      if (input.lastStartedAt && input.lastStartedAt.getTime() >= candidate.getTime()) {
        return new Date(candidate.getTime() + intervalMs);
      }
      return candidate;
    }

    case 'daily': {
      if (!input.anchorAt) return null;
      const slot = todayAt(now, input.anchorAt);
      const nextSlot =
        slot.getTime() <= now.getTime() ||
        (input.lastStartedAt && input.lastStartedAt.getTime() >= slot.getTime())
          ? addDays(slot, 1)
          : slot;
      return nextSlot;
    }

    case 'weekly': {
      if (!input.anchorAt) return null;
      const target = input.anchorAt.getDay();
      const slot = nextWeekdayAt(now, target, input.anchorAt);
      const nextSlot =
        input.lastStartedAt && input.lastStartedAt.getTime() >= slot.getTime()
          ? addDays(slot, 7)
          : slot;
      return nextSlot;
    }

    case 'monthly': {
      if (!input.anchorAt || !input.monthlyDay) return null;
      const slot = monthlySlot(now, input.monthlyDay, input.anchorAt);
      const nextSlot =
        slot.getTime() <= now.getTime() ||
        (input.lastStartedAt && input.lastStartedAt.getTime() >= slot.getTime())
          ? monthlySlotForMonth(addMonths(slot, 1), input.monthlyDay, input.anchorAt)
          : slot;
      return nextSlot;
    }

    case 'cron': {
      if (!input.cronExpr) return null;
      return nextCronSlot(input.cronExpr, now);
    }
  }
}

// ---- Slot helpers --------------------------------------------------------
//
// All time-of-day extraction happens in the API process's local TZ. For
// production deployments the API and operators are expected to share a
// timezone; multi-TZ awareness is a follow-up.

/** Today at the same HH:MM:SS as `time`. */
function todayAt(now: Date, time: Date): Date {
  const d = new Date(now);
  d.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), 0);
  return d;
}

/** This week's `weekday` (0-6) at the same HH:MM:SS as `time`. */
function nextWeekdayAt(now: Date, weekday: number, time: Date): Date {
  const candidate = new Date(now);
  candidate.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), 0);
  const delta = (weekday - candidate.getDay() + 7) % 7;
  if (delta === 0 && candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  } else {
    candidate.setDate(candidate.getDate() + delta);
  }
  return candidate;
}

/** Resolve `monthlyDay` against the month containing `now`. */
function monthlySlot(now: Date, monthlyDay: MonthlyDay, time: Date): Date {
  return monthlySlotForMonth(now, monthlyDay, time);
}

/** Resolve `monthlyDay` against the month containing `monthMarker`. */
function monthlySlotForMonth(monthMarker: Date, monthlyDay: MonthlyDay, time: Date): Date {
  const year = monthMarker.getFullYear();
  const month = monthMarker.getMonth();
  const day = monthlyDay === 'last' ? lastDayOfMonth(year, month) : Number(monthlyDay);
  return new Date(year, month, day, time.getHours(), time.getMinutes(), time.getSeconds(), 0);
}

function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of next month = last day of this month.
  return new Date(year, month + 1, 0).getDate();
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}
