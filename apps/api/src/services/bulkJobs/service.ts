// SPDX-License-Identifier: BUSL-1.1
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  BulkJob,
  BulkJobAction,
  BulkJobCounts,
  BulkJobPauseReason,
  BulkJobRow,
  BulkJobRowStatus,
  BulkJobStatus,
} from '@openaduc/shared';
import type { BulkJobRowsTable, BulkJobsTable, DB } from '../db/types.js';
import type { ProviderFactory } from '../providers/registry.js';
import {
  DirectoryUnavailableError,
  type DirectoryProvider,
  type WriteContext,
} from '../providers/types.js';
import type { AuditEventInput, AuditService } from './audit.js';
import { wasAudited } from './auditContext.js';
import type { CredentialCacheService } from './credentialCache.js';
import type { SessionsService } from './sessions.js';
import { writeUserAccount } from './userAccountWrite.js';
import type { UserLiveRefreshService } from './userLiveRefresh.js';

type JobRecord = Selectable<BulkJobsTable>;
type RowRecord = Selectable<BulkJobRowsTable>;

/** Who starts, continues, retries or stops a job, and from which request. */
export interface BulkJobStarter {
  directoryId: number;
  adminSessionId: string;
  actorUserId: string;
  actorDisplayName: string | null;
  actorUsername: string;
  sourceIp: string | null;
  userAgent: string | null;
  correlationId: string;
}

/** Rows of one job written at once: enough to keep a DC busy, not to flood it. */
const ROW_CONCURRENCY = 4;
const HEARTBEAT_MS = 10_000;
/** A running job whose heartbeat is older than this has lost its process. */
const STALE_AFTER_MS = 60_000;
const SWEEP_MS = 30_000;
/** How long shutdown waits for rows in flight before leaving them interrupted. */
const STOP_WAIT_MS = 4_000;
const INSERT_CHUNK = 1_000;

/**
 * Bulk actions as server-side jobs, run in-process. A job's rows are
 * written as its operator, with the password cached for their elevated
 * session, which is never stored with the job: when that session ends
 * (idle, absolute lifetime, step-down, sign-out) the job pauses until the
 * operator steps up and continues it. A process that stops mid-job leaves
 * it paused as `interrupted`, its in-flight rows failed and retryable,
 * because whether their write landed is unknown.
 *
 * Every audit event a job writes carries its id: the `bulk.create` event
 * heads the group, followed by one event per row (the same shape as the
 * single-object route's) and any `bulk.pause`, `bulk.resume`, `bulk.retry`
 * or `bulk.cancel`.
 */
export class BulkJobService {
  private readonly runs = new Map<string, Promise<void>>();
  private sweepHandle: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly services: {
      audit: AuditService;
      sessions: SessionsService;
      credentialCache: CredentialCacheService;
      providers: ProviderFactory;
      userLiveRefresh: UserLiveRefreshService;
    },
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.sweepHandle) return;
    void this.recoverStale();
    this.sweepHandle = setInterval(() => void this.recoverStale(), SWEEP_MS);
    this.sweepHandle.unref?.();
  }

  /** Lets rows in flight finish (briefly), then leaves running jobs interrupted. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    this.sweepHandle = null;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(this.runs.values()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  async create(starter: BulkJobStarter, action: BulkJobAction, ids: string[]): Promise<string> {
    const targets = ids.map((id) => id.toLowerCase());
    const cached = await this.db
      .selectFrom('user_cache_records')
      .select(['object_guid', 'distinguished_name', 'display_name', 'sam_account_name'])
      .where('provider_id', '=', starter.directoryId)
      .where('object_guid', 'in', targets)
      .execute();
    const byId = new Map(cached.map((u) => [u.object_guid, u]));

    const jobId = await this.db.transaction().execute(async (trx) => {
      const job = await trx
        .insertInto('bulk_jobs')
        .values({ ...this.startColumns(starter), provider_id: starter.directoryId, action })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (let i = 0; i < targets.length; i += INSERT_CHUNK) {
        await trx
          .insertInto('bulk_job_rows')
          .values(
            targets.slice(i, i + INSERT_CHUNK).map((id, j) => {
              const user = byId.get(id);
              return {
                job_id: job.id,
                ordinal: i + j,
                target_id: id,
                target_dn: user?.distinguished_name ?? null,
                target_name: user ? (user.display_name ?? user.sam_account_name) : null,
              };
            }),
          )
          .execute();
      }
      return job.id;
    });

    // Like any write, a job that can't be audited doesn't run.
    try {
      await this.services.audit.recordEvent({
        ...this.auditBase(starter, jobId),
        action: 'bulk.create',
        result: 'success',
        targetType: 'user',
        metadata: { action, total: targets.length },
      });
    } catch (err) {
      await this.db.deleteFrom('bulk_jobs').where('id', '=', jobId).execute();
      throw err;
    }
    this.kick(jobId);
    return jobId;
  }

  /** The job, if it's in this directory and the operator's own. */
  async find(id: string, directoryId: number, actorUserId: string): Promise<JobRecord | null> {
    const job = await this.db
      .selectFrom('bulk_jobs')
      .selectAll()
      .where('id', '=', id)
      .where('provider_id', '=', directoryId)
      .where('actor_user_id', '=', actorUserId)
      .executeTakeFirst();
    return job ?? null;
  }

  async list(directoryId: number, actorUserId: string, limit: number): Promise<BulkJob[]> {
    const jobs = await this.db
      .selectFrom('bulk_jobs')
      .selectAll()
      .where('provider_id', '=', directoryId)
      .where('actor_user_id', '=', actorUserId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return this.describe(jobs);
  }

  async describe(jobs: JobRecord[]): Promise<BulkJob[]> {
    const counts = await this.counts(jobs.map((j) => j.id));
    return jobs.map((j) => ({
      id: String(j.id),
      action: j.action as BulkJobAction,
      status: j.status as BulkJobStatus,
      pauseReason: j.pause_reason as BulkJobPauseReason | null,
      actorDisplayName: j.actor_display_name,
      createdAt: new Date(j.created_at).toISOString(),
      finishedAt: j.finished_at ? new Date(j.finished_at).toISOString() : null,
      counts: counts.get(String(j.id)) ?? emptyCounts(),
    }));
  }

  async describeOne(id: string): Promise<BulkJob> {
    const job = await this.db
      .selectFrom('bulk_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return (await this.describe([job]))[0]!;
  }

  /** Each job's rows by status, for the audit log as well as the job's own view. */
  async counts(jobIds: string[]): Promise<Map<string, BulkJobCounts>> {
    const out = new Map<string, BulkJobCounts>();
    if (jobIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('bulk_job_rows')
      .select(['job_id', 'status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('job_id', 'in', jobIds)
      .groupBy(['job_id', 'status'])
      .execute();
    for (const r of rows) {
      const key = String(r.job_id);
      const counts = out.get(key) ?? emptyCounts();
      const n = Number(r.n);
      counts.total += n;
      if (r.status in counts) counts[r.status as BulkJobRowStatus] += n;
      out.set(key, counts);
    }
    return out;
  }

  async rows(jobId: string, status?: BulkJobRowStatus): Promise<BulkJobRow[]> {
    let q = this.db.selectFrom('bulk_job_rows').selectAll().where('job_id', '=', jobId);
    if (status) q = q.where('status', '=', status);
    const rows = await q.orderBy('ordinal').execute();
    return rows.map((r) => ({
      targetId: r.target_id,
      targetName: r.target_name,
      status: r.status as BulkJobRowStatus,
      errorCode: r.error_code,
      errorMessage: r.error_message,
    }));
  }

  /** Continue a paused job on the operator's current elevated session. */
  async resume(job: JobRecord, starter: BulkJobStarter): Promise<boolean> {
    const resumed = await this.db
      .updateTable('bulk_jobs')
      .set({ ...this.startColumns(starter), pause_reason: null })
      .where('id', '=', job.id)
      .where('status', '=', 'paused')
      .executeTakeFirst();
    if (Number(resumed.numUpdatedRows) === 0) return false;
    await this.services.audit.recordEvent({
      ...this.auditBase(starter, job.id),
      action: 'bulk.resume',
      result: 'success',
      targetType: 'user',
      metadata: { action: job.action },
    });
    this.kick(job.id);
    return true;
  }

  /** Run a stopped job's failed rows again. False when it's running or none failed. */
  async retry(job: JobRecord, starter: BulkJobStarter): Promise<boolean> {
    const retried = await this.db
      .transaction()
      .execute(async (trx) => {
        const claimed = await trx
          .updateTable('bulk_jobs')
          .set({ ...this.startColumns(starter), pause_reason: null, finished_at: null })
          .where('id', '=', job.id)
          .where('status', 'in', ['paused', 'finished', 'cancelled'])
          .executeTakeFirst();
        if (Number(claimed.numUpdatedRows) === 0) return 0;
        const rows = await trx
          .updateTable('bulk_job_rows')
          .set({ status: 'pending', error_code: null, error_message: null, finished_at: null })
          .where('job_id', '=', job.id)
          .where('status', '=', 'failed')
          .executeTakeFirst();
        const n = Number(rows.numUpdatedRows);
        // Nothing to retry: leave the job as it was.
        if (n === 0) throw new NothingToRetry();
        return n;
      })
      .catch((err) => {
        if (err instanceof NothingToRetry) return 0;
        throw err;
      });
    if (retried === 0) return false;
    await this.services.audit.recordEvent({
      ...this.auditBase(starter, job.id),
      action: 'bulk.retry',
      result: 'success',
      targetType: 'user',
      metadata: { action: job.action, rows: retried },
    });
    this.kick(job.id);
    return true;
  }

  /** Stop a job: rows not yet started are skipped; rows in flight finish. */
  async cancel(job: JobRecord, starter: BulkJobStarter): Promise<boolean> {
    const skipped = await this.db.transaction().execute(async (trx) => {
      const stopped = await trx
        .updateTable('bulk_jobs')
        .set({ status: 'cancelled', pause_reason: null, finished_at: new Date() })
        .where('id', '=', job.id)
        .where('status', 'in', ['queued', 'running', 'paused'])
        .executeTakeFirst();
      if (Number(stopped.numUpdatedRows) === 0) return null;
      const rows = await trx
        .updateTable('bulk_job_rows')
        .set({ status: 'skipped' })
        .where('job_id', '=', job.id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return Number(rows.numUpdatedRows);
    });
    if (skipped === null) return false;
    await this.services.audit.recordEvent({
      ...this.auditBase(starter, job.id),
      action: 'bulk.cancel',
      result: 'success',
      targetType: 'user',
      metadata: { action: job.action, skipped },
    });
    return true;
  }

  /**
   * Pause jobs whose process is gone (their heartbeat stopped), failing
   * the rows they had in flight so the operator can check and retry them.
   */
  async recoverStale(): Promise<void> {
    try {
      const stale = await this.db
        .updateTable('bulk_jobs')
        .set({ status: 'paused', pause_reason: 'interrupted' })
        .where('status', 'in', ['queued', 'running'])
        .where('heartbeat_at', '<', new Date(Date.now() - STALE_AFTER_MS))
        .returningAll()
        .execute();
      for (const job of stale) {
        await this.interruptRows(job.id);
        await this.recordPause(job, 'interrupted');
      }
    } catch (err) {
      this.logger.error({ err }, 'recovering interrupted bulk jobs failed');
    }
  }

  private kick(jobId: string): void {
    if (this.stopping) return;
    // A run still winding down (it has just finished or paused) goes first;
    // the next one only claims the job if it's queued again by then.
    const before = this.runs.get(jobId) ?? Promise.resolve();
    const run = before
      .then(() => this.run(jobId))
      .catch((err) => this.logger.error({ err, jobId }, 'bulk job run failed'))
      .finally(() => {
        if (this.runs.get(jobId) === run) this.runs.delete(jobId);
      });
    this.runs.set(jobId, run);
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.db
      .updateTable('bulk_jobs')
      .set({ status: 'running', heartbeat_at: new Date() })
      .where('id', '=', jobId)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirst();
    if (!job) return;

    const heartbeat = setInterval(() => {
      this.db
        .updateTable('bulk_jobs')
        .set({ heartbeat_at: new Date() })
        .where('id', '=', jobId)
        .where('status', '=', 'running')
        .execute()
        .catch((err) => this.logger.warn({ err, jobId }, 'bulk job heartbeat failed'));
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    // An object, so the workers' writes aren't lost to narrowing.
    const stopped: { pause: BulkJobPauseReason | null } = { pause: null };
    try {
      const provider = await this.services.providers.buildForDirectory(job.provider_id);
      const worker = async (): Promise<void> => {
        while (!stopped.pause && !this.stopping) {
          const writeCtx = await this.credentials(job);
          if (!writeCtx) {
            stopped.pause = 'step_up_required';
            return;
          }
          const row = await this.claimRow(jobId);
          if (!row) return;
          await this.runRow(job, provider, row, writeCtx);
        }
      };
      await Promise.all(Array.from({ length: ROW_CONCURRENCY }, worker));
      if (this.stopping) stopped.pause ??= 'interrupted';
    } catch (err) {
      this.logger.error({ err, jobId }, 'bulk job stopped');
      stopped.pause = 'interrupted';
    } finally {
      clearInterval(heartbeat);
    }

    const { pause } = stopped;
    if (pause) {
      const paused = await this.db
        .updateTable('bulk_jobs')
        .set({ status: 'paused', pause_reason: pause })
        .where('id', '=', jobId)
        .where('status', '=', 'running')
        .executeTakeFirst();
      if (Number(paused.numUpdatedRows) > 0) {
        if (pause === 'interrupted') await this.interruptRows(jobId);
        await this.recordPause(job, pause);
      }
      return;
    }
    await this.db
      .updateTable('bulk_jobs')
      .set({ status: 'finished', finished_at: new Date() })
      .where('id', '=', jobId)
      .where('status', '=', 'running')
      .execute();
  }

  /** The operator's write credentials, while their elevated session lives. */
  private async credentials(job: JobRecord): Promise<WriteContext | null> {
    const elevated = await this.services.sessions.findActiveElevated(job.admin_session_id);
    const password = elevated ? this.services.credentialCache.get(elevated.id) : null;
    if (!password) return null;
    return {
      actorUserId: job.actor_user_id,
      actorUsername: job.actor_username,
      actorPassword: password,
      correlationId: job.correlation_id ?? '',
    };
  }

  /** The next pending row, marked running; null once none are left or the job stopped. */
  private async claimRow(jobId: string): Promise<RowRecord | null> {
    const { rows } = await sql<RowRecord>`
      UPDATE bulk_job_rows
      SET status = 'running', attempts = attempts + 1, started_at = now()
      WHERE id = (
        SELECT r.id FROM bulk_job_rows r
        JOIN bulk_jobs j ON j.id = r.job_id
        WHERE r.job_id = ${jobId} AND r.status = 'pending' AND j.status = 'running'
        ORDER BY r.ordinal
        LIMIT 1
        FOR UPDATE OF r SKIP LOCKED
      )
      RETURNING *
    `.execute(this.db);
    return rows[0] ?? null;
  }

  private async runRow(
    job: JobRecord,
    provider: DirectoryProvider,
    row: RowRecord,
    writeCtx: WriteContext,
  ): Promise<void> {
    const audit = this.auditBase(job, job.id);
    let outcome: {
      status: 'succeeded' | 'failed';
      errorCode?: string | null;
      errorMessage?: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      dn?: string;
    };
    try {
      const written = await writeUserAccount(
        this.services,
        provider,
        job.action as BulkJobAction,
        row.target_id,
        writeCtx,
        audit,
      );
      if (!written) {
        await this.services.audit.recordEvent({
          ...audit,
          action: job.action,
          result: 'failure',
          errorCode: 'not_found',
          targetType: 'user',
          targetId: row.target_id,
          targetDn: row.target_dn,
        });
        outcome = { status: 'failed', errorCode: 'not_found' };
      } else {
        const { result, user } = written;
        outcome = {
          status: result.ok ? 'succeeded' : 'failed',
          errorCode: result.ok ? null : (result.errorCode ?? 'directory_error'),
          errorMessage: result.errorMessage ?? null,
          before: result.before ?? null,
          after: result.after ?? null,
          dn: user.distinguishedName,
        };
      }
    } catch (err) {
      const errorCode =
        err instanceof DirectoryUnavailableError ? 'directory_unavailable' : 'internal_error';
      if (errorCode === 'internal_error') {
        this.logger.error({ err, jobId: job.id, rowId: row.id }, 'bulk job row failed');
      }
      if (!wasAudited(err)) {
        await this.services.audit
          .recordEvent({
            ...audit,
            action: job.action,
            result: 'failure',
            errorCode,
            targetType: 'user',
            targetId: row.target_id,
            targetDn: row.target_dn,
          })
          .catch((auditErr) => this.logger.error({ err: auditErr }, 'audit insert failed'));
      }
      outcome = { status: 'failed', errorCode };
    }

    await this.db
      .updateTable('bulk_job_rows')
      .set({
        status: outcome.status,
        error_code: outcome.errorCode ?? null,
        error_message:
          outcome.status === 'failed'
            ? failureMessage(outcome.errorCode ?? null, outcome.errorMessage ?? null)
            : null,
        before_json: outcome.before ? JSON.stringify(outcome.before) : null,
        after_json: outcome.after ? JSON.stringify(outcome.after) : null,
        ...(outcome.dn ? { target_dn: outcome.dn } : {}),
        finished_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
  }

  private async interruptRows(jobId: string): Promise<void> {
    await this.db
      .updateTable('bulk_job_rows')
      .set({
        status: 'failed',
        error_code: 'interrupted',
        error_message: failureMessage('interrupted', null),
        finished_at: new Date(),
      })
      .where('job_id', '=', jobId)
      .where('status', '=', 'running')
      .execute();
  }

  private async recordPause(job: JobRecord, reason: BulkJobPauseReason): Promise<void> {
    await this.services.audit
      .recordEvent({
        ...this.auditBase(job, job.id),
        action: 'bulk.pause',
        result: 'success',
        actorAuthMethod: 'system',
        targetType: 'user',
        metadata: { action: job.action, reason },
      })
      .catch((err) => this.logger.error({ err }, 'audit insert failed for bulk.pause'));
  }

  private startColumns(starter: BulkJobStarter) {
    return {
      status: 'queued',
      actor_user_id: starter.actorUserId,
      actor_display_name: starter.actorDisplayName,
      actor_username: starter.actorUsername,
      admin_session_id: starter.adminSessionId,
      source_ip: starter.sourceIp,
      user_agent: starter.userAgent,
      correlation_id: starter.correlationId,
      heartbeat_at: new Date(),
    } as const;
  }

  private auditBase(
    who: BulkJobStarter | JobRecord,
    jobId: string,
  ): Omit<AuditEventInput, 'action' | 'result'> {
    const fields =
      'actorUserId' in who
        ? who
        : {
            directoryId: who.provider_id,
            adminSessionId: who.admin_session_id,
            actorUserId: who.actor_user_id,
            actorDisplayName: who.actor_display_name,
            sourceIp: who.source_ip,
            userAgent: who.user_agent,
            correlationId: who.correlation_id,
          };
    return {
      actorUserId: fields.actorUserId,
      actorDisplayName: fields.actorDisplayName,
      actorAuthMethod: 'ad-password',
      sourceIp: fields.sourceIp,
      userAgent: fields.userAgent,
      sessionId: fields.adminSessionId,
      correlationId: fields.correlationId,
      providerId: fields.directoryId,
      bulkJobId: String(jobId),
    };
  }
}

class NothingToRetry extends Error {}

function emptyCounts(): BulkJobCounts {
  return { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
}

/** What a failed row says to the operator. */
function failureMessage(code: string | null, detail: string | null): string {
  const reason = detail ? `: ${detail}` : '';
  switch (code) {
    case 'not_found':
      return 'No such user in the directory.';
    case 'permission_denied':
      return `The directory refused the change${reason}`;
    case 'directory_unavailable':
      return 'No domain controller could be reached.';
    case 'interrupted':
      return 'OpenADUC stopped while changing this account. Check it, then retry.';
    default:
      return `The change failed${reason}`;
  }
}
