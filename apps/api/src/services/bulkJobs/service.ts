// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  BULK_REVERT_ACTIONS,
  bulkJobRevertRequestSchema,
  canRevert,
  revertedAction,
  revertRefusal,
  type BulkJobKind,
  type BulkRevertableAction,
  type AuditBulkSummary,
  type BulkJob,
  type BulkJobAction,
  type BulkJobCounts,
  type BulkJobPauseReason,
  type BulkJobRevertPreview,
  type BulkJobRow,
  type BulkJobRowStatus,
  type BulkJobStatus,
  type BulkJobSubject,
} from '@openaduc/shared';
import type { BulkJobRowsTable, BulkJobsTable, DB } from '../../db/types.js';
import type { ProviderFactory } from '../../providers/registry.js';
import {
  DirectoryUnavailableError,
  type DirectoryProvider,
  type WriteContext,
} from '../../providers/types.js';
import type { AuditEventInput, AuditService } from '../audit.js';
import { wasAudited } from '../auditContext.js';
import type { CredentialCacheService } from '../credentialCache.js';
import type { SessionsService } from '../sessions.js';
import type { MembershipCacheDeps } from '../groupMembershipWrite.js';
import { BulkJobRequestError } from './errors.js';
import {
  BULK_JOB_HANDLERS,
  type BulkJobHandlers,
  type BulkJobRowInput,
  type BulkRowOutcome,
} from './handlers.js';
import {
  directoryLookup,
  planRevert,
  revertInput,
  revertPreview,
  revertRunner,
  type BulkRevertRunner,
  type RevertPlan,
} from './reverts.js';
import { failureMessage } from './rowMessages.js';

export type JobRecord = Selectable<BulkJobsTable>;
type RowRecord = Selectable<BulkJobRowsTable>;

/** The operator a job writes as, and the request that last started it. */
export interface JobActor {
  directoryId: number;
  adminSessionId: string;
  actorUserId: string;
  actorDisplayName: string | null;
  actorUsername: string;
  sourceIp: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

export interface BulkJobDeps {
  audit: Pick<AuditService, 'recordEvent'>;
  sessions: Pick<SessionsService, 'findActiveElevated'>;
  credentialCache: Pick<CredentialCacheService, 'get'>;
  providers: Pick<ProviderFactory, 'buildForDirectory'>;
  userLiveRefresh: MembershipCacheDeps['userLiveRefresh'];
}

/** Enough rows at once to keep a DC busy, not to flood it. */
const ROW_CONCURRENCY = 4;
const HEARTBEAT_MS = 10_000;
/** A job whose heartbeat is older than this has lost its run. */
const STALE_AFTER = sql<Date>`now() - interval '60 seconds'`;
const SWEEP_MS = 30_000;
const STOP_WAIT_MS = 4_000;
const INSERT_CHUNK = 1_000;
/** The rows a retry runs again: those with changes still to make. */
const RETRIED: BulkJobRowStatus[] = ['failed', 'partial'];
/** A job in these may still write; one revert of a job at a time may be (bulk_jobs_one_open_revert_uq). */
const OPEN: BulkJobStatus[] = ['queued', 'running', 'paused'];

const REVERT_RUNNING = 'This job is being reverted already.';

/** A unique violation on bulk_jobs_one_open_revert_uq, as the refusal it is; anything else rethrown. */
function revertRunning(err: unknown): never {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505') {
    throw new BulkJobRequestError('revert_running', REVERT_RUNNING);
  }
  throw err;
}

const lockJob = (db: Kysely<DB>, id: string) =>
  db.selectFrom('bulk_jobs').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();

/**
 * The jobs among these with a revert, other than `except`, that may still
 * write: not stopped, or stopped with rows still running (a stop lets
 * them finish).
 */
async function withOpenReverts(
  db: Kysely<DB>,
  jobIds: string[],
  except?: string,
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  let q = db
    .selectFrom('bulk_jobs as revert')
    .select('revert.reverts_job_id')
    .where('revert.reverts_job_id', 'in', jobIds)
    .where((eb) =>
      eb.or([
        eb('revert.status', 'in', OPEN),
        eb.exists(
          eb
            .selectFrom('bulk_job_rows as r')
            .select('r.id')
            .whereRef('r.job_id', '=', 'revert.id')
            .where('r.status', '=', 'running'),
        ),
      ]),
    );
  if (except) q = q.where('revert.id', '<>', except);
  return new Set((await q.execute()).map((r) => String(r.reverts_job_id)));
}

const hasOpenRevert = async (db: Kysely<DB>, jobId: string, except?: string) =>
  (await withOpenReverts(db, [jobId], except)).has(String(jobId));

/** The job's action, as one a revert can put back, once revertRefusal has passed it. */
function revertable(job: JobRecord): BulkRevertableAction {
  if (!canRevert(job.action)) throw new Error(`${job.action} can't be reverted`);
  return job.action;
}

/**
 * Bulk actions as server-side jobs, run in-process. A job's rows are
 * written as its operator, with the password cached for their elevated
 * session, which is never stored with the job: when that session ends
 * (idle, absolute lifetime, step-down, sign-out) the job pauses until the
 * operator steps up and continues it. It also pauses when no domain
 * controller answers. A process that stops mid-job leaves it paused as
 * `interrupted`, its in-flight rows failed and retryable, because whether
 * their write landed is unknown.
 *
 * Each run claims the job with a fresh `run_token`; heartbeats, row
 * claims and results, pausing and finishing all match it, so a run that
 * lost the job (to the stale sweep, a stop, or a newer run) can't change
 * it any more.
 *
 * Every audit event a job writes carries its id: the `bulk.create` event
 * heads the group, followed by one event per row (the same shape as the
 * single-object route's) and any `bulk.pause`, `bulk.resume`, `bulk.retry`
 * or `bulk.cancel`.
 *
 * A revert is a job too, of the same action, pointing at the job it
 * reverts (`reverts_job_id`, also in its `bulk.create` event); its rows run
 * through `revertRunner` rather than the action's handler.
 */
export class BulkJobService {
  private readonly runs = new Map<string, Promise<void>>();
  private sweepHandle: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: BulkJobDeps,
    private readonly logger: FastifyBaseLogger,
    readonly handlers: BulkJobHandlers = BULK_JOB_HANDLERS,
  ) {}

  start(): void {
    if (this.sweepHandle) return;
    void this.recoverStale();
    this.sweepHandle = setInterval(() => void this.recoverStale(), SWEEP_MS);
    this.sweepHandle.unref?.();
  }

  /** Lets rows in flight finish (briefly); running jobs are left interrupted. */
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

  /**
   * Throws a ZodError for a bad request body, and BulkJobRequestError for
   * one that can't start. `authorize` sees what the job acts with before
   * anything is stored, to refuse what the operator may not do.
   */
  async create(
    actor: JobActor,
    action: BulkJobAction,
    body: unknown,
    authorize?: (subject: BulkJobSubject | null) => Promise<void>,
  ): Promise<string> {
    const handler = this.handlers[action];
    const request = handler.request.parse(body);
    const rows = handler.rows(request);
    const subject =
      (await handler.prepare?.(request, { db: this.db, directoryId: actor.directoryId })) ?? null;
    await authorize?.(subject);
    return this.insert(actor, action, subject, rows);
  }

  /**
   * Revert a stopped job: a new job, of the opposite action, that puts back
   * each row's before-values, on the rows previewed (a token from
   * `previewRevert`). Rows changed again since the job are left alone
   * unless `include` names them. The caller checks the operator may make
   * its writes. The job is locked while the revert is stored, so a retry
   * of it, or another revert, can't start alongside.
   */
  async revert(actor: JobActor, job: JobRecord, body: unknown): Promise<string> {
    const request = bulkJobRevertRequestSchema.parse(body);
    const plan = await this.plan(job);
    if (request.previewToken !== plan.token) {
      throw new BulkJobRequestError(
        'preview_mismatch',
        'The accounts have changed since the preview. Preview the revert again.',
      );
    }
    const included = new Set(
      request.include === 'all'
        ? plan.modified.map((r) => r.targetId)
        : request.include.map((id) => id.toLowerCase()),
    );
    const forced = plan.modified.filter((r) => included.has(r.targetId));
    const chosen = [
      ...plan.revert.map((r) => ({ row: r, force: false })),
      ...forced.map((r) => ({ row: r, force: true })),
    ].sort((a, b) => a.row.ordinal - b.row.ordinal);
    if (chosen.length === 0) {
      throw new BulkJobRequestError(
        'nothing_to_revert',
        'Nothing to revert: every account the job changed is back as it was, changed since, or can’t be reverted.',
      );
    }
    const guarded = chosen
      .flatMap(({ row }) => row.readds)
      .map((id) => plan.protectedGroups.get(id))
      .find((name) => name !== undefined);
    if (guarded && !request.acknowledgeProtected) {
      throw new BulkJobRequestError(
        'protected_unacknowledged',
        `Reverting puts users back in ${guarded}, which gives them admin rights in AD. Confirm that they need them.`,
      );
    }
    const rows = chosen.map(({ row, force }) => ({
      targetId: row.targetId,
      input: revertInput(String(job.id), row, force),
    }));
    return this.insert(actor, BULK_REVERT_ACTIONS[revertable(job)], job.subject_json, rows, {
      revertsJobId: String(job.id),
      metadata: {
        leftAsChanged: plan.modified.length - forced.length,
        notRevertible: plan.notRevertible.length,
      },
      guard: async (trx) => {
        const locked = await lockJob(trx, job.id);
        const refusal = await this.refusal(trx, locked);
        if (refusal) throw new BulkJobRequestError(refusal.code, refusal.message);
        const at = (d: Date | string | null) => (d === null ? null : new Date(d).getTime());
        if (at(locked.finished_at) !== at(job.finished_at)) {
          throw new BulkJobRequestError(
            'preview_mismatch',
            'The job has run again since the preview. Preview the revert again.',
          );
        }
      },
    }).catch(revertRunning);
  }

  /** What reverting the job would do, read from the cache. */
  async previewRevert(job: JobRecord): Promise<BulkJobRevertPreview> {
    return revertPreview(this.db, job.provider_id, await this.plan(job));
  }

  private async plan(job: JobRecord): Promise<RevertPlan> {
    const refusal = await this.refusal(this.db, job);
    if (refusal) throw new BulkJobRequestError(refusal.code, refusal.message);
    const provider = await this.deps.providers.buildForDirectory(job.provider_id);
    return planRevert(this.db, job, revertable(job), directoryLookup(provider));
  }

  private async refusal(db: Kysely<DB>, job: JobRecord) {
    const [described] = await this.describe([job], db);
    return revertRefusal(described!, await hasOpenRevert(db, String(job.id)));
  }

  /** What runs a job's rows: its action's handler, or for a revert, what puts them back. */
  runner(job: Pick<JobRecord, 'action' | 'reverts_job_id'>): BulkRevertRunner {
    return job.reverts_job_id === null
      ? this.handlers[job.action as BulkJobAction]
      : revertRunner(revertedAction(job.action));
  }

  private async insert(
    actor: JobActor,
    action: BulkJobKind,
    subject: BulkJobSubject | null,
    rows: BulkJobRowInput<unknown>[],
    revert?: {
      revertsJobId: string;
      metadata: Record<string, unknown>;
      /** Run in the transaction that stores the job, first; throws to refuse it. */
      guard: (trx: Transaction<DB>) => Promise<void>;
    },
  ): Promise<string> {
    const cached = await this.db
      .selectFrom('user_cache_records')
      .select(['object_guid', 'distinguished_name', 'display_name', 'sam_account_name'])
      .where('provider_id', '=', actor.directoryId)
      .where(
        'object_guid',
        'in',
        rows.map((r) => r.targetId),
      )
      .execute();
    const byId = new Map(cached.map((u) => [u.object_guid, u]));

    const jobId = await this.db.transaction().execute(async (trx) => {
      await revert?.guard(trx);
      const job = await trx
        .insertInto('bulk_jobs')
        .values({
          ...actorColumns(actor),
          status: 'queued',
          heartbeat_at: sql`now()`,
          action,
          subject_json: subject ? JSON.stringify(subject) : null,
          reverts_job_id: revert?.revertsJobId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await trx
          .insertInto('bulk_job_rows')
          .values(
            rows.slice(i, i + INSERT_CHUNK).map((row, j) => {
              const user = byId.get(row.targetId);
              return {
                job_id: job.id,
                ordinal: i + j,
                target_id: row.targetId,
                target_dn: user?.distinguished_name ?? null,
                target_name: user ? (user.display_name ?? user.sam_account_name) : null,
                input_json: row.input === null ? null : JSON.stringify(row.input),
              };
            }),
          )
          .execute();
      }
      return job.id;
    });

    // Like any write, a job that can't be audited doesn't run.
    try {
      await this.deps.audit.recordEvent({
        ...auditBase(actor, jobId),
        action: 'bulk.create',
        result: 'success',
        targetType: 'user',
        metadata: {
          action,
          total: rows.length,
          ...(subject ? { subject } : {}),
          ...(revert ? { revertsJobId: revert.revertsJobId, ...revert.metadata } : {}),
        },
      });
    } catch (err) {
      await this.db.deleteFrom('bulk_jobs').where('id', '=', jobId).execute();
      throw err;
    }
    this.kick(jobId);
    return jobId;
  }

  /** The job, if it's in this directory, whoever's it is. */
  async findInDirectory(id: string, directoryId: number): Promise<JobRecord | null> {
    const job = await this.db
      .selectFrom('bulk_jobs')
      .selectAll()
      .where('id', '=', id)
      .where('provider_id', '=', directoryId)
      .executeTakeFirst();
    return job ?? null;
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

  async describeOne(id: string): Promise<BulkJob> {
    const job = await this.db
      .selectFrom('bulk_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return (await this.describe([job]))[0]!;
  }

  /** The audit log's view of these jobs, by id; a job whose record is gone is missing. */
  async summaries(
    jobIds: string[],
  ): Promise<
    Map<
      string,
      Pick<AuditBulkSummary, 'status' | 'pauseReason' | 'counts' | 'revertible' | 'revertedBy'>
    >
  > {
    if (jobIds.length === 0) return new Map();
    const jobs = await this.db
      .selectFrom('bulk_jobs')
      .selectAll()
      .where('id', 'in', jobIds)
      .execute();
    return new Map((await this.describe(jobs)).map((j) => [j.id, j]));
  }

  async rows(jobId: string, status?: BulkJobRowStatus): Promise<BulkJobRow[]> {
    let q = this.db.selectFrom('bulk_job_rows').selectAll().where('job_id', '=', jobId);
    if (status) q = q.where('status', '=', status);
    const rows = await q.orderBy('ordinal').execute();
    return rows.map((r) => ({
      targetId: r.target_id,
      targetName: r.target_name,
      status: r.status,
      errorCode: r.error_code,
      errorMessage: r.error_message,
    }));
  }

  /** Continue a paused job on the operator's current elevated session. */
  async resume(job: JobRecord, actor: JobActor): Promise<boolean> {
    const resumed = await this.db
      .updateTable('bulk_jobs')
      .set({
        ...actorColumns(actor),
        status: 'queued',
        heartbeat_at: sql`now()`,
        pause_reason: null,
      })
      .where('id', '=', job.id)
      .where('status', '=', 'paused')
      .executeTakeFirst();
    if (Number(resumed.numUpdatedRows) === 0) return false;
    await this.record(actor, job, 'bulk.resume', {});
    this.kick(job.id);
    return true;
  }

  /** Run a stopped job's failed and partial rows again. False when it's running or none failed. */
  async retry(job: JobRecord, actor: JobActor): Promise<boolean> {
    const retried = await this.retryRows(job, actor).catch(revertRunning);
    if (retried === 0) return false;
    await this.record(actor, job, 'bulk.retry', { rows: retried });
    this.kick(job.id);
    return true;
  }

  private async retryRows(job: JobRecord, actor: JobActor): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      // As a revert locks it, so a retry and a revert can't both start.
      const reverted = job.reverts_job_id ?? job.id;
      await lockJob(trx, reverted);
      if (await hasOpenRevert(trx, reverted, job.id)) {
        throw new BulkJobRequestError('revert_running', REVERT_RUNNING);
      }
      const queued = await trx
        .updateTable('bulk_jobs')
        .set({
          ...actorColumns(actor),
          status: 'queued',
          heartbeat_at: sql`now()`,
          pause_reason: null,
          finished_at: null,
        })
        .where('id', '=', job.id)
        .where('status', 'in', ['paused', 'finished', 'cancelled'])
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('bulk_job_rows')
              .select('id')
              .where('job_id', '=', job.id)
              .where('status', 'in', RETRIED),
          ),
        )
        .executeTakeFirst();
      if (Number(queued.numUpdatedRows) === 0) return 0;
      const rows = await trx
        .updateTable('bulk_job_rows')
        .set({ status: 'pending', error_code: null, error_message: null, finished_at: null })
        .where('job_id', '=', job.id)
        .where('status', 'in', RETRIED)
        .executeTakeFirst();
      return Number(rows.numUpdatedRows);
    });
  }

  /** Stop a job: rows not yet started are skipped; rows in flight finish. */
  async cancel(job: JobRecord, actor: JobActor): Promise<boolean> {
    const skipped = await this.db.transaction().execute(async (trx) => {
      const stopped = await trx
        .updateTable('bulk_jobs')
        .set({ status: 'cancelled', pause_reason: null, run_token: null, finished_at: sql`now()` })
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
    await this.record(actor, job, 'bulk.cancel', { skipped });
    return true;
  }

  /**
   * Pause jobs whose run is gone (their heartbeat stopped), failing the
   * rows they had in flight so the operator can check and retry them.
   */
  async recoverStale(): Promise<void> {
    try {
      const stale = await this.db
        .updateTable('bulk_jobs')
        .set({ status: 'paused', pause_reason: 'interrupted', run_token: null })
        .where('status', 'in', ['queued', 'running'])
        .where('heartbeat_at', '<', STALE_AFTER)
        .returningAll()
        .execute();
      for (const job of stale) {
        await this.interruptRows(job.id, null);
        await this.recordPause(job, 'interrupted');
      }
    } catch (err) {
      this.logger.error({ err }, 'recovering interrupted bulk jobs failed');
    }
  }

  private kick(jobId: string): void {
    if (this.stopping) return;
    // A run still winding down goes first; the next one only claims the job
    // if it's queued by then.
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
    const token = randomUUID();
    const job = await this.db
      .updateTable('bulk_jobs')
      .set({ status: 'running', run_token: token, heartbeat_at: sql`now()` })
      .where('id', '=', jobId)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirst();
    if (!job) return;

    const heartbeat = setInterval(() => {
      this.db
        .updateTable('bulk_jobs')
        .set({ heartbeat_at: sql`now()` })
        .where('id', '=', jobId)
        .where('run_token', '=', token)
        .execute()
        .catch((err) => this.logger.warn({ err, jobId }, 'bulk job heartbeat failed'));
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    // An object, so the workers' writes aren't lost to narrowing.
    const stopped: { pause: BulkJobPauseReason | null } = { pause: null };
    try {
      const provider = await this.deps.providers.buildForDirectory(job.provider_id);
      const worker = async (): Promise<void> => {
        while (!stopped.pause && !this.stopping) {
          const writeCtx = await this.credentials(job);
          if (!writeCtx) {
            stopped.pause = 'step_up_required';
            return;
          }
          if (stopped.pause) return;
          const row = await this.claimRow(jobId, token);
          if (!row) return;
          await this.runRow(job, token, provider, row, writeCtx, (reason) => {
            stopped.pause = reason;
          });
        }
      };
      // A failed worker stops the others claiming rows; the rows they have
      // in flight finish before the job settles.
      await Promise.allSettled(
        Array.from({ length: ROW_CONCURRENCY }, () =>
          worker().catch((err: unknown) => {
            this.logger.error({ err, jobId }, 'bulk job worker failed');
            stopped.pause = 'interrupted';
          }),
        ),
      );
      if (this.stopping) stopped.pause ??= 'interrupted';
    } catch (err) {
      this.logger.error({ err, jobId }, 'bulk job stopped');
      stopped.pause = 'interrupted';
    } finally {
      clearInterval(heartbeat);
    }
    await this.settle(job, token, stopped.pause);
  }

  /** End a run: pause the job, or finish it when no rows are left. */
  private async settle(
    job: JobRecord,
    token: string,
    pause: BulkJobPauseReason | null,
  ): Promise<void> {
    if (pause) {
      const paused = await this.db
        .updateTable('bulk_jobs')
        .set({ status: 'paused', pause_reason: pause, run_token: null })
        .where('id', '=', job.id)
        .where('run_token', '=', token)
        .where('status', '=', 'running')
        .executeTakeFirst();
      if (Number(paused.numUpdatedRows) === 0) return;
      await this.interruptRows(job.id, token);
      await this.recordPause(job, pause);
      return;
    }
    await this.db
      .updateTable('bulk_jobs')
      .set({ status: 'finished', run_token: null, finished_at: sql`now()` })
      .where('id', '=', job.id)
      .where('run_token', '=', token)
      .where('status', '=', 'running')
      .execute();
  }

  /** The operator's write credentials, while their elevated session lives. */
  private async credentials(job: JobRecord): Promise<WriteContext | null> {
    const elevated = await this.deps.sessions.findActiveElevated(job.admin_session_id);
    const password = elevated ? this.deps.credentialCache.get(elevated.id) : null;
    if (!password) return null;
    return {
      actorUserId: job.actor_user_id,
      actorUsername: job.actor_username,
      actorPassword: password,
      correlationId: job.correlation_id ?? '',
    };
  }

  /** The next pending row, marked running for this run; null once none are left or the run lost the job. */
  private async claimRow(jobId: string, token: string): Promise<RowRecord | null> {
    const { rows } = await sql<RowRecord>`
      UPDATE bulk_job_rows
      SET status = 'running', run_token = ${token}, attempts = attempts + 1, started_at = now()
      WHERE id = (
        SELECT r.id FROM bulk_job_rows r
        JOIN bulk_jobs j ON j.id = r.job_id
        WHERE r.job_id = ${jobId} AND r.status = 'pending'
          AND j.status = 'running' AND j.run_token = ${token}
        ORDER BY r.ordinal
        LIMIT 1
        FOR UPDATE OF r SKIP LOCKED
      )
      RETURNING *
    `.execute(this.db);
    return rows[0] ?? null;
  }

  /**
   * Run one row and record its outcome. `pause` is told, before anything
   * else is awaited, when the job should pause, so no other worker claims
   * a row meanwhile.
   */
  private async runRow(
    job: JobRecord,
    token: string,
    provider: DirectoryProvider,
    row: RowRecord,
    writeCtx: WriteContext,
    pause: (reason: BulkJobPauseReason) => void,
  ): Promise<void> {
    const handler = this.runner(job);
    const audit = auditBase(actorOf(job), job.id);
    let outcome: BulkRowOutcome;
    try {
      outcome = await handler.run(
        {
          targetId: row.target_id,
          targetDn: row.target_dn,
          input: handler.input.parse(row.input_json),
          before: row.before_json,
          after: row.after_json,
        },
        { db: this.db, provider, writeCtx, audit, services: this.deps },
      );
    } catch (err) {
      if (err instanceof DirectoryUnavailableError && !wasAudited(err)) {
        pause('directory_unavailable');
        // Nothing was written: the row waits for the job to continue.
        await this.db
          .updateTable('bulk_job_rows')
          .set({ status: 'pending' })
          .where('id', '=', row.id)
          .where('run_token', '=', token)
          .execute();
        return;
      }
      const errorCode =
        err instanceof DirectoryUnavailableError ? 'directory_unavailable' : 'internal_error';
      if (errorCode === 'internal_error') {
        this.logger.error({ err, jobId: job.id, rowId: row.id }, 'bulk job row failed');
      }
      outcome = { ok: false, errorCode, audited: wasAudited(err) };
    }
    if (!outcome.ok && outcome.errorCode === 'directory_unavailable')
      pause('directory_unavailable');

    if (!outcome.ok && !outcome.audited) {
      await this.deps.audit
        .recordEvent({
          ...audit,
          action: job.action,
          result: 'failure',
          errorCode: outcome.errorCode,
          targetType: 'user',
          targetId: row.target_id,
          targetDn: outcome.targetDn ?? row.target_dn,
        })
        .catch((err) => this.logger.error({ err }, 'audit insert failed'));
    }

    await this.db
      .updateTable('bulk_job_rows')
      .set({
        status: outcome.ok
          ? outcome.unchanged
            ? 'skipped'
            : 'succeeded'
          : outcome.partial
            ? 'partial'
            : 'failed',
        error_code: outcome.ok ? (outcome.reason?.code ?? null) : outcome.errorCode,
        error_message: outcome.ok
          ? (outcome.reason?.message ?? null)
          : (outcome.message ?? failureMessage(outcome.errorCode, outcome.errorMessage ?? null)),
        before_json: outcome.before ? JSON.stringify(outcome.before) : null,
        after_json: outcome.after ? JSON.stringify(outcome.after) : null,
        ...(outcome.targetDn ? { target_dn: outcome.targetDn } : {}),
        finished_at: sql`now()`,
      })
      .where('id', '=', row.id)
      .where('run_token', '=', token)
      .execute();
  }

  /** Fail the rows a run left in flight (any run's, with no token). */
  private async interruptRows(jobId: string, token: string | null): Promise<void> {
    let q = this.db
      .updateTable('bulk_job_rows')
      .set({
        status: 'failed',
        error_code: 'interrupted',
        error_message: failureMessage('interrupted', null),
        finished_at: sql`now()`,
      })
      .where('job_id', '=', jobId)
      .where('status', '=', 'running');
    if (token) q = q.where('run_token', '=', token);
    await q.execute();
  }

  private async recordPause(job: JobRecord, reason: BulkJobPauseReason): Promise<void> {
    await this.deps.audit
      .recordEvent({
        ...auditBase(actorOf(job), job.id),
        action: 'bulk.pause',
        result: 'success',
        actorAuthMethod: 'system',
        targetType: 'user',
        metadata: { action: job.action, reason },
      })
      .catch((err) => this.logger.error({ err }, 'audit insert failed for bulk.pause'));
  }

  private async record(
    actor: JobActor,
    job: JobRecord,
    action: 'bulk.resume' | 'bulk.retry' | 'bulk.cancel',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.recordEvent({
      ...auditBase(actor, job.id),
      action,
      result: 'success',
      targetType: 'user',
      metadata: { action: job.action, ...metadata },
    });
  }

  private async describe(jobs: JobRecord[], db: Kysely<DB> = this.db): Promise<BulkJob[]> {
    const ids = jobs.map((j) => String(j.id));
    const [counts, open, reverts] = await Promise.all([
      this.counts(ids, db),
      withOpenReverts(db, ids),
      ids.length === 0
        ? []
        : db
            .selectFrom('bulk_jobs')
            .select(['id', 'reverts_job_id', 'actor_display_name', 'created_at', 'status'])
            .where('reverts_job_id', 'in', ids)
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .execute(),
    ]);
    const latestRevert = new Map<string, (typeof reverts)[number]>();
    for (const r of reverts) {
      const of = String(r.reverts_job_id);
      if (!latestRevert.has(of)) latestRevert.set(of, r);
    }
    return jobs.map((j) => {
      const id = String(j.id);
      const revert = latestRevert.get(id);
      const job = {
        id,
        action: j.action,
        revertsJobId: j.reverts_job_id === null ? null : String(j.reverts_job_id),
        subject: j.subject_json,
        status: j.status,
        pauseReason: j.pause_reason,
        actorDisplayName: j.actor_display_name,
        createdAt: new Date(j.created_at).toISOString(),
        finishedAt: j.finished_at ? new Date(j.finished_at).toISOString() : null,
        counts: counts.get(id) ?? emptyCounts(),
      };
      return {
        ...job,
        revertible: revertRefusal(job, open.has(id)) === null,
        revertedBy: revert
          ? {
              jobId: String(revert.id),
              actorDisplayName: revert.actor_display_name,
              createdAt: new Date(revert.created_at).toISOString(),
              status: revert.status,
            }
          : null,
      };
    });
  }

  private async counts(jobIds: string[], db: Kysely<DB>): Promise<Map<string, BulkJobCounts>> {
    const out = new Map<string, BulkJobCounts>();
    if (jobIds.length === 0) return out;
    const rows = await db
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
      counts[r.status] += n;
      out.set(key, counts);
    }
    return out;
  }
}

function actorOf(job: JobRecord): JobActor {
  return {
    directoryId: job.provider_id,
    adminSessionId: job.admin_session_id,
    actorUserId: job.actor_user_id,
    actorDisplayName: job.actor_display_name,
    actorUsername: job.actor_username,
    sourceIp: job.source_ip,
    userAgent: job.user_agent,
    correlationId: job.correlation_id,
  };
}

function actorColumns(actor: JobActor) {
  return {
    provider_id: actor.directoryId,
    admin_session_id: actor.adminSessionId,
    actor_user_id: actor.actorUserId,
    actor_display_name: actor.actorDisplayName,
    actor_username: actor.actorUsername,
    source_ip: actor.sourceIp,
    user_agent: actor.userAgent,
    correlation_id: actor.correlationId,
  };
}

function auditBase(actor: JobActor, jobId: string): Omit<AuditEventInput, 'action' | 'result'> {
  return {
    actorUserId: actor.actorUserId,
    actorDisplayName: actor.actorDisplayName,
    actorAuthMethod: 'ad-password',
    sourceIp: actor.sourceIp,
    userAgent: actor.userAgent,
    sessionId: actor.adminSessionId,
    correlationId: actor.correlationId,
    providerId: actor.directoryId,
    bulkJobId: String(jobId),
  };
}

function emptyCounts(): BulkJobCounts {
  return { total: 0, pending: 0, running: 0, succeeded: 0, partial: 0, failed: 0, skipped: 0 };
}
