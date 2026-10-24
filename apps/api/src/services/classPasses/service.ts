// SPDX-License-Identifier: BUSL-1.1
// Class Temporary Access Passes: what an import with "Issue TAPs for
// class" leaves to do once its accounts exist. Each of its people gets a
// pass that starts with their class, made once Connect Sync has brought
// them to Entra, often days ahead. Graph shows a pass's value only in the
// response that makes it, so it's kept, encrypted with the app's secret
// key and bound to its job and row, until it expires or is replaced
// (docs/adr/0003-class-taps-are-stored-until-they-expire.md).
//
// The follow-up runs in-process without the operator: Graph is called with
// the app's client credentials and AD read with the service account, never
// with the operator's password, which a job holds only while their
// elevated session lives. What it may do was fixed when the operator,
// holding write:user.issueTap and stepped up, ran the import: a pass for
// each account the import created, for the class they scheduled, within
// the tenant's policy, and never to anyone who is or may be an
// administrator, checked again each time a pass is made.
//
// Its state is class_passes, so a restart carries on where it was: a due
// pass is claimed (claim_token) for a lease, and one whose process died
// is due again when the lease lapses. Graph throttling holds back that
// directory's passes for as long as Graph asks.
import { randomUUID } from 'node:crypto';
import {
  classStartOf,
  classTapProblems,
  tapExpiresAt,
  type ClassPassReissue,
  type ClassPassReveal,
  type ClassRoster,
  type ClassRosterRow,
  type ClassStart,
  type ClassTapRequest,
} from '@openaduc/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import type { ClassPassesTable, DB } from '../../db/types.js';
import type { RoleGroup } from '../../lib/groupPrivilege.js';
import { decryptSecret, encryptSecret } from '../../lib/encryption.js';
import { AppError, NotFound } from '../../plugins/errorHandler.js';
import type { ProviderFactory } from '../../providers/registry.js';
import { DirectoryUnavailableError } from '../../providers/types.js';
import type { AuditEventInput, AuditService } from '../audit.js';
import type { JobRecord } from '../bulkJobs/service.js';
import { listOf, tenantLastSync } from '../entraLookup.js';
import type { EntraIntegrationService } from '../entraIntegration.js';
import {
  GraphPermissionError,
  GraphThrottledError,
  type GraphClientFactory,
} from '../graphClient.js';
import { issueTap, tapUserOf, tenantTapPolicy } from '../temporaryAccessPass.js';
import {
  errorRetryMs,
  graphPassStatus,
  nearClass,
  passWindow,
  syncRetryMs,
  timedPassStatus,
} from './rules.js';

export interface ClassPassDeps {
  db: Kysely<DB>;
  audit: Pick<AuditService, 'recordEvent'>;
  entra: Pick<EntraIntegrationService, 'isFeatureEnabled'>;
  graph: Pick<GraphClientFactory, 'build'>;
  providers: Pick<ProviderFactory, 'buildForDirectory'>;
  roleGroups: () => Promise<readonly RoleGroup[]>;
  logger: FastifyBaseLogger;
}

/** Who a pass is made or changed by, as the audit log names them. */
export type ClassPassActor = Pick<
  AuditEventInput,
  | 'actorUserId'
  | 'actorDisplayName'
  | 'actorAuthMethod'
  | 'sourceIp'
  | 'userAgent'
  | 'sessionId'
  | 'correlationId'
>;

const TICK_MS = 30_000;
/** How long a claimed pass is the claimer's before another process may take it. */
const LEASE = sql<Date>`now() + interval '10 minutes'`;
/** How long one tick keeps making passes before it lets the next one go on. */
const TICK_BUDGET_MS = 25_000;
const STOP_WAIT_MS = 4_000;
const STATUS_READS = 4;
const OFF_RETRY_MS = 15 * 60_000;
const INSERT_CHUNK = 1_000;

const bindingOf = (jobId: string, rowId: string) => `class_passes:${jobId}:${rowId}`;

const REFUSALS = new Set([
  'privileged',
  'entra_admin_role',
  'entra_roles_unknown',
  'membership_unknown',
]);

const livePassSchema = z.object({
  id: z.string().nullish(),
  methodUsabilityReason: z.string().nullish(),
});

type Pass = Selectable<ClassPassesTable> & {
  target_id: string | null;
  target_dn: string | null;
  provider_id: number;
  actor_user_id: string;
  actor_display_name: string | null;
  lifetime_minutes: number;
  is_usable_once: boolean;
};

type Attempt =
  | {
      kind: 'issued';
      entraUserId: string;
      methodId: string | null;
      value: string;
      startsAt: string;
      expiresAt: string;
      isUsableOnce: boolean;
      late: boolean;
    }
  | { kind: 'unsynced'; lastSyncAt: string | null }
  | { kind: 'retry'; code: string; message: string; afterMs: number }
  | { kind: 'refused' | 'failed'; code: string; message: string };

/**
 * Store the class an import's people get passes for, and a pass to make
 * for each of its rows, in the transaction that stores the job.
 */
export async function storeClass(
  trx: Kysely<DB>,
  jobId: string,
  classTap: ClassTapRequest,
): Promise<void> {
  await trx
    .insertInto('import_classes')
    .values({
      job_id: jobId,
      start: JSON.stringify(classTap.start),
      lifetime_minutes: classTap.lifetimeMinutes,
      is_usable_once: classTap.isUsableOnce,
    })
    .execute();
  const rows = await trx
    .selectFrom('bulk_job_rows')
    .select(['id', sql<string | null>`input_json->>'startDate'`.as('start_date')])
    .where('job_id', '=', jobId)
    .execute();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await trx
      .insertInto('class_passes')
      .values(
        rows.slice(i, i + INSERT_CHUNK).map((r) => ({
          row_id: r.id,
          job_id: jobId,
          class_starts_at: classStartOf(classTap.start, r.start_date)?.toISOString() ?? null,
        })),
      )
      .execute();
  }
}

/** Delete the values of passes past their expiry. Returns how many went. */
async function purgeExpiredPasses(db: Kysely<DB>): Promise<number> {
  const purged = await db
    .updateTable('class_passes')
    .set({ pass_enc: null, updated_at: sql`now()` })
    .where('pass_enc', 'is not', null)
    .where('expires_at', '<=', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(purged.numUpdatedRows);
}

const held = (p: Pick<Pass, 'pass_enc' | 'expires_at'>, now: Date) =>
  p.pass_enc !== null && p.expires_at !== null && new Date(p.expires_at) > now;

export class ClassPassService {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopping = false;
  /** Directories Graph has throttled, until when. */
  private readonly throttledUntil = new Map<number, number>();

  constructor(private readonly deps: ClassPassDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.timer.unref?.();
    this.kick();
  }

  /** Stop the timer, letting a sweep under way finish (briefly). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ticking ?? Promise.resolve(),
      new Promise((resolve) => {
        wait = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(wait);
    this.stopping = false;
  }

  /** Sweep now, while the timer runs, rather than at its next tick. */
  kick(): void {
    if (!this.timer || this.ticking) return;
    this.ticking = this.tick().finally(() => {
      this.ticking = null;
    });
  }

  private async tick(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.deps.logger.error({ err }, 'class passes tick failed');
    }
  }

  /**
   * Delete the values of expired passes, then make the passes that are
   * due, until none are or the tick's time is up. Returns how many were
   * tried.
   */
  async sweep(budgetMs = TICK_BUDGET_MS): Promise<number> {
    await purgeExpiredPasses(this.deps.db);
    const until = Date.now() + budgetMs;
    let tried = 0;
    while (Date.now() < until && !this.stopping) {
      const claimed = await this.claimDue();
      if (!claimed) break;
      tried++;
      await this.make(claimed.pass, claimed.token, this.systemActor(claimed.pass), {
        action: 'import.classPass.issue',
        auditWaits: false,
      });
    }
    return tried;
  }

  private systemActor(pass: Pass): ClassPassActor {
    return {
      actorUserId: pass.actor_user_id,
      actorDisplayName: pass.actor_display_name,
      actorAuthMethod: 'system',
    };
  }

  /** Claim the next due pass whose account the import has created. */
  private async claimDue(): Promise<{ pass: Pass; token: string } | null> {
    const now = Date.now();
    const throttled = [...this.throttledUntil].flatMap(([id, at]) => (at > now ? [id] : []));
    const token = randomUUID();
    const { rows } = await sql<{ row_id: string }>`
      UPDATE class_passes SET claim_token = ${token}, attempts = attempts + 1,
        next_attempt_at = ${LEASE}, updated_at = now()
      WHERE row_id = (
        SELECT p.row_id FROM class_passes p
        JOIN bulk_job_rows r ON r.id = p.row_id
        JOIN bulk_jobs j ON j.id = p.job_id
        WHERE p.status = 'waiting' AND p.next_attempt_at <= now()
          AND r.target_id IS NOT NULL AND r.status IN ('succeeded', 'partial')
          AND NOT (j.provider_id = ANY(${throttled}::int[]))
        ORDER BY p.next_attempt_at
        LIMIT 1
        FOR UPDATE OF p SKIP LOCKED
      )
      RETURNING row_id
    `.execute(this.deps.db);
    const rowId = rows[0]?.row_id;
    if (!rowId) return null;
    const pass = await this.load(String(rowId));
    return pass ? { pass, token } : null;
  }

  private async load(rowId: string, jobId?: string): Promise<Pass | null> {
    let q = this.deps.db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .innerJoin('bulk_jobs as j', 'j.id', 'p.job_id')
      .innerJoin('import_classes as c', 'c.job_id', 'p.job_id')
      .selectAll('p')
      .select([
        'r.target_id',
        'r.target_dn',
        'j.provider_id',
        'j.actor_user_id',
        'j.actor_display_name',
        'c.lifetime_minutes',
        'c.is_usable_once',
      ])
      .where('p.row_id', '=', rowId);
    if (jobId) q = q.where('p.job_id', '=', jobId);
    return (await q.executeTakeFirst()) ?? null;
  }

  /** Make one claimed pass and record how it went. */
  private async make(
    pass: Pass,
    token: string,
    actor: ClassPassActor,
    how: { action: string; auditWaits: boolean },
  ): Promise<Attempt> {
    const now = new Date();
    const attempt = await this.attempt(pass, now);
    if (attempt.kind === 'retry' && attempt.code === 'entra_throttled') {
      this.throttledUntil.set(pass.provider_id, now.getTime() + attempt.afterMs);
    }
    await this.record(pass, token, attempt, now, actor, how);
    return attempt;
  }

  private async attempt(pass: Pass, now: Date): Promise<Attempt> {
    const failed = (code: string, message: string): Attempt => ({ kind: 'failed', code, message });
    if (!pass.class_starts_at) {
      return failed(
        'no_start',
        'Has no start date, so there’s no class for their pass to start at.',
      );
    }
    const window = passWindow(new Date(pass.class_starts_at), pass.lifetime_minutes, now);
    if (!window) {
      return failed(
        'class_over',
        'Class was over before their pass could be made. Reschedule class to give them one.',
      );
    }
    const off: Attempt = {
      kind: 'retry',
      code: 'tap_not_enabled',
      message: 'Temporary Access Pass is turned off for this directory.',
      afterMs: OFF_RETRY_MS,
    };
    const { provider_id: directoryId } = pass;
    if (!(await this.deps.entra.isFeatureEnabled(directoryId, 'temporaryAccessPass'))) return off;
    const graph = await this.deps.graph.build(directoryId);
    if (!graph) return off;

    try {
      const directory = await this.deps.providers.buildForDirectory(directoryId);
      const id = { kind: 'objectGuid' as const, value: pass.target_id! };
      const user = await directory.getUser(id);
      if (!user) return failed('not_found', 'The account is no longer in the directory.');
      const outcome = await issueTap(
        {
          graph,
          tokenGroups: () => directory.getUserTokenGroups(id),
          roleGroups: await this.deps.roleGroups(),
          now: () => now,
        },
        tapUserOf(user),
        {
          startsAt: window.startsAt,
          lifetimeMinutes: window.lifetimeMinutes,
          isUsableOnce: pass.is_usable_once,
          // Whatever pass they hold was made for this class, or nobody knows its value.
          replaceExisting: true,
          fitLifetime: window.late,
        },
      );
      if (outcome.ok) {
        return {
          kind: 'issued',
          entraUserId: outcome.entraUserId,
          methodId: outcome.methodId,
          value: outcome.issued.temporaryAccessPass,
          startsAt: outcome.issued.startsAt,
          expiresAt: outcome.issued.expiresAt,
          isUsableOnce: outcome.issued.isUsableOnce,
          late: window.late,
        };
      }
      if (outcome.code === 'unsynced') {
        return { kind: 'unsynced', lastSyncAt: await tenantLastSync(graph) };
      }
      return {
        kind: REFUSALS.has(outcome.code) ? 'refused' : 'failed',
        code: outcome.code,
        message: outcome.message,
      };
    } catch (err) {
      const retry = (code: string, message: string, afterMs = errorRetryMs(pass.attempts)) =>
        ({ kind: 'retry', code, message, afterMs }) as const;
      if (err instanceof GraphThrottledError) {
        return retry(
          'entra_throttled',
          'Microsoft Graph is busy.',
          Math.max(30_000, err.retryAfterSeconds * 1000),
        );
      }
      if (err instanceof GraphPermissionError && err.statusCode === 400) {
        return failed(
          'entra_rejected',
          `Microsoft Entra refused: ${err.graphMessage ?? err.message}`,
        );
      }
      if (err instanceof GraphPermissionError) {
        return retry('entra_error', err.hint ? `${err.message} (${err.hint})` : err.message);
      }
      if (err instanceof DirectoryUnavailableError) {
        return retry('directory_unavailable', 'No domain controller could be reached.');
      }
      this.deps.logger.error({ err, rowId: pass.row_id }, 'making a class pass failed');
      return retry('internal_error', 'Something went wrong making their pass.');
    }
  }

  /**
   * Record how making a pass went. A made pass replaces the one held, its
   * value and its audit row stored together; a refusal deletes the one
   * held; anything else leaves a pass still held as it was (a reissue
   * that didn't take), or waits to try again.
   */
  private async record(
    pass: Pass,
    token: string,
    attempt: Attempt,
    now: Date,
    actor: ClassPassActor,
    how: { action: string; auditWaits: boolean },
  ): Promise<void> {
    const { db } = this.deps;
    const rowId = String(pass.row_id);
    const jobId = String(pass.job_id);
    const audit = (result: 'success' | 'failure', more: Partial<AuditEventInput>) => ({
      ...actor,
      action: how.action,
      result,
      providerId: pass.provider_id,
      bulkJobId: jobId,
      targetType: 'user' as const,
      targetId: pass.target_id,
      targetDn: pass.target_dn,
      ...more,
    });
    const update = (set: Record<string, unknown>, trx: Kysely<DB> = db) =>
      trx
        .updateTable('class_passes')
        .set({ ...set, claim_token: null, updated_at: sql`now()` })
        .where('row_id', '=', rowId)
        .where('claim_token', '=', token)
        .executeTakeFirst();
    const cleared = {
      pass_enc: null,
      entra_method_id: null,
      pass_starts_at: null,
      expires_at: null,
    };
    const keepsHeld = pass.status === 'issued' && held(pass, now);
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

    switch (attempt.kind) {
      case 'issued': {
        await db
          .transaction()
          .execute(async (trx) => {
            const stored = await update(
              {
                status: 'issued',
                entra_user_id: attempt.entraUserId,
                entra_method_id: attempt.methodId,
                pass_enc: encryptSecret(attempt.value, bindingOf(jobId, rowId)),
                pass_starts_at: attempt.startsAt,
                expires_at: attempt.expiresAt,
                error_code: null,
                message: null,
                tenant_last_sync_at: null,
              },
              trx,
            );
            // Lost the claim: whoever has it now makes the pass again.
            if (Number(stored.numUpdatedRows) === 0) throw new LostClaim();
            await this.deps.audit.recordEvent(
              audit('success', {
                after: {
                  entraUserId: attempt.entraUserId,
                  startsAt: attempt.startsAt,
                  expiresAt: attempt.expiresAt,
                  isUsableOnce: attempt.isUsableOnce,
                  ...(attempt.late ? { late: true } : {}),
                },
                metadata: { classStartsAt: pass.class_starts_at },
              }),
              trx,
            );
          })
          .catch(async (err: unknown) => {
            if (err instanceof LostClaim) return;
            this.deps.logger.error({ err, rowId }, 'storing a class pass failed');
            // Graph holds a pass nobody knows: the next try replaces it.
            await update({
              status: keepsHeld ? 'issued' : 'waiting',
              error_code: 'internal_error',
              message: 'Their pass couldn’t be stored.',
              next_attempt_at: at(errorRetryMs(pass.attempts)),
            });
          });
        return;
      }
      case 'unsynced':
        await update({
          status: 'waiting',
          ...cleared,
          error_code: 'unsynced',
          message: null,
          tenant_last_sync_at: attempt.lastSyncAt,
          next_attempt_at: at(
            syncRetryMs(
              pass.attempts,
              pass.class_starts_at ? new Date(pass.class_starts_at) : null,
              now,
            ),
          ),
        });
        if (how.auditWaits) {
          await this.deps.audit.recordEvent(audit('failure', { errorCode: 'unsynced' }));
        }
        return;
      case 'retry':
        await update(
          keepsHeld
            ? { next_attempt_at: sql`now()` }
            : {
                status: 'waiting',
                error_code: attempt.code,
                message: attempt.message,
                next_attempt_at: at(attempt.afterMs),
              },
        );
        if (how.auditWaits) {
          await this.deps.audit.recordEvent(audit('failure', { errorCode: attempt.code }));
        }
        return;
      case 'refused':
      case 'failed':
        await update(
          attempt.kind === 'failed' && keepsHeld
            ? { next_attempt_at: sql`now()` }
            : {
                status: attempt.kind,
                ...cleared,
                error_code: attempt.code,
                message: attempt.message,
                next_attempt_at: sql`now()`,
              },
        );
        await this.deps.audit.recordEvent(
          audit('failure', { errorCode: attempt.code, metadata: { message: attempt.message } }),
        );
        return;
    }
  }

  // ---- The class roster ---------------------------------------------------

  private async classOf(job: JobRecord) {
    const found = await this.deps.db
      .selectFrom('import_classes')
      .selectAll()
      .where('job_id', '=', job.id)
      .executeTakeFirst();
    if (!found) throw NotFound('This import didn’t schedule a class.');
    return found;
  }

  /** Whether the job has a class, and how many of its people class finds still not in Entra. */
  async alertOf(jobId: string): Promise<{ unsyncedAlert: ClassRoster['unsyncedAlert'] } | null> {
    const found = await this.deps.db
      .selectFrom('import_classes')
      .select('lifetime_minutes')
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    if (!found) return null;
    const passes = await this.deps.db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .select(['p.status', 'p.class_starts_at', 'r.target_id'])
      .where('p.job_id', '=', jobId)
      .execute();
    return { unsyncedAlert: unsyncedAlert(passes, found.lifetime_minutes, new Date()) };
  }

  /** The class roster: each person, how their pass stands in Entra, and whether it's held. */
  async roster(job: JobRecord, readerId: string): Promise<ClassRoster> {
    const { db } = this.deps;
    const klass = await this.classOf(job);
    const graph = await this.deps.graph.build(job.provider_id);
    const now = new Date();
    const rows = await db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .selectAll('p')
      .select(['r.status as row_status', 'r.target_id', 'r.input_json', 'r.error_message'])
      .where('p.job_id', '=', job.id)
      .orderBy('r.ordinal')
      .execute();

    let statusError: string | null = null;
    const live = new Map<string, { status: ClassRosterRow['status']; message: string | null }>();
    const toRead = rows.filter(
      (r) =>
        r.status === 'issued' && r.entra_user_id && r.expires_at && new Date(r.expires_at) > now,
    );
    if (graph) {
      await inBatches(toRead, STATUS_READS, async (r) => {
        try {
          const res = await graph.getJson(
            `/users/${encodeURIComponent(r.entra_user_id!)}/authentication/temporaryAccessPassMethods`,
          );
          const passes = listOf(livePassSchema).parse(res.data).value;
          live.set(String(r.row_id), graphPassStatus(passes[0] ?? null, r.entra_method_id));
        } catch (err) {
          if (!(err instanceof GraphThrottledError || err instanceof GraphPermissionError))
            throw err;
          statusError =
            err instanceof GraphThrottledError
              ? 'Microsoft Graph is busy, so some passes show what their times say.'
              : `OpenADUC couldn’t ask Entra how the passes stand: ${err.message}`;
        }
      });
    }
    // A pass Entra says is spent, or is no longer the one it holds, needn't be kept.
    const spent = [...live].flatMap(([rowId, s]) =>
      s.status === 'used' || s.status === 'expired' || s.status === 'replaced' ? [rowId] : [],
    );
    if (spent.length > 0) {
      await db
        .updateTable('class_passes')
        .set({ pass_enc: null, updated_at: sql`now()` })
        .where('row_id', 'in', spent)
        .where('pass_enc', 'is not', null)
        .execute();
    }

    const lifetime = klass.lifetime_minutes;
    const rosterRows = rows.map((r): ClassRosterRow => {
      const input = r.input_json ?? {};
      const rowId = String(r.row_id);
      const classEnds = r.class_starts_at ? tapExpiresAt(r.class_starts_at, lifetime) : null;
      const base = {
        rowId,
        line: Number(input['line']),
        displayName: String(input['displayName'] ?? ''),
        samAccountName: String(input['samAccountName'] ?? ''),
        personalEmail: (input['otherMailbox'] as string | null) ?? null,
        mobile: (input['mobile'] as string | null) ?? null,
        id: r.target_id,
        message: r.message,
        startsAt: r.class_starts_at ? new Date(r.class_starts_at).toISOString() : null,
        expiresAt: classEnds?.toISOString() ?? null,
        held: held(r, now) && !spent.includes(rowId),
      };
      if (r.status === 'issued') {
        const times = {
          startsAt: new Date(r.pass_starts_at ?? r.class_starts_at!),
          expiresAt: new Date(r.expires_at!),
        };
        const known = live.get(rowId) ?? { status: timedPassStatus(times, now), message: null };
        return {
          ...base,
          ...known,
          startsAt: times.startsAt.toISOString(),
          expiresAt: times.expiresAt.toISOString(),
        };
      }
      if (r.status === 'refused' || r.status === 'failed') return { ...base, status: r.status };
      if (!r.target_id) {
        const coming = r.row_status === 'pending' || r.row_status === 'running';
        return {
          ...base,
          status: coming ? 'awaitingAccount' : 'notCreated',
          message: coming ? null : r.error_message,
        };
      }
      return {
        ...base,
        status: r.error_code && r.error_code !== 'unsynced' ? 'retrying' : 'waitingForSync',
      };
    });

    return {
      job: {
        id: String(job.id),
        actorDisplayName: job.actor_display_name,
        createdAt: new Date(job.created_at).toISOString(),
        own: job.actor_user_id === readerId,
      },
      class: {
        start: klass.start,
        lifetimeMinutes: lifetime,
        isUsableOnce: klass.is_usable_once,
        updatedAt: new Date(klass.updated_at).toISOString(),
      },
      lastSyncAt: graph ? await tenantLastSync(graph) : null,
      unsyncedAlert: unsyncedAlert(rows, lifetime, now),
      statusError,
      rows: rosterRows.sort((a, b) => a.line - b.line),
    };
  }

  /** A held pass's value, audited as revealed (never the value), the reveal refused once it isn't held. */
  async reveal(
    job: JobRecord,
    rowId: string,
    audit: Omit<AuditEventInput, 'action' | 'result'>,
  ): Promise<ClassPassReveal> {
    const pass = await this.load(rowId, String(job.id));
    if (!pass) throw NotFound('That person isn’t on this class roster.');
    const event = (result: 'success' | 'failure', more: Partial<AuditEventInput> = {}) => ({
      ...audit,
      action: 'import.classPass.reveal',
      result,
      actorAuthMethod: 'ad-password' as const,
      providerId: job.provider_id,
      bulkJobId: String(job.id),
      targetType: 'user' as const,
      targetId: pass.target_id,
      targetDn: pass.target_dn,
      ...more,
    });
    if (pass.status !== 'issued' || !held(pass, new Date())) {
      await this.deps.audit.recordEvent(event('failure', { errorCode: 'not_held' }));
      throw new AppError({
        statusCode: 410,
        code: 'gone',
        message:
          pass.status === 'issued'
            ? 'OpenADUC no longer holds this pass: it expired or was used. Reissue it if they need another.'
            : 'They have no pass to reveal yet.',
      });
    }
    const value = decryptSecret(pass.pass_enc!, bindingOf(String(job.id), rowId));
    const startsAt = new Date(pass.pass_starts_at ?? pass.class_starts_at!).toISOString();
    const expiresAt = new Date(pass.expires_at!).toISOString();
    // Audited before it's handed over: a reveal that can't be audited doesn't happen.
    await this.deps.audit.recordEvent(event('success', { metadata: { startsAt, expiresAt } }));
    return { temporaryAccessPass: value, startsAt, expiresAt, isUsableOnce: pass.is_usable_once };
  }

  /**
   * Make one person's pass again, now, for the class as scheduled: a lost
   * or burned pass is replaced, and one still waiting is tried at once.
   * Audited as the operator's, whatever came of it.
   */
  async reissue(job: JobRecord, rowId: string, actor: ClassPassActor): Promise<ClassPassReissue> {
    await this.classOf(job);
    const token = randomUUID();
    const claimed = await this.deps.db
      .updateTable('class_passes')
      .set({ claim_token: token, attempts: 1, next_attempt_at: LEASE, updated_at: sql`now()` })
      .where('row_id', '=', rowId)
      .where('job_id', '=', job.id)
      .where((eb) =>
        eb.or([eb('claim_token', 'is', null), eb('next_attempt_at', '<=', sql<Date>`now()`)]),
      )
      .executeTakeFirst();
    const pass = await this.load(rowId, String(job.id));
    if (!pass) throw NotFound('That person isn’t on this class roster.');
    if (Number(claimed.numUpdatedRows) === 0) {
      throw new AppError({
        statusCode: 409,
        code: 'class_pass_busy',
        message: 'Their pass is being made right now. Try again in a moment.',
      });
    }
    if (!pass.target_id) {
      await this.deps.db
        .updateTable('class_passes')
        .set({ claim_token: null, next_attempt_at: sql`now()` })
        .where('row_id', '=', rowId)
        .where('claim_token', '=', token)
        .execute();
      throw new AppError({
        statusCode: 409,
        code: 'not_created',
        message: 'The import hasn’t created their account, so there’s no one to give a pass to.',
      });
    }
    const attempt = await this.make(pass, token, actor, {
      action: 'import.classPass.reissue',
      auditWaits: true,
    });
    switch (attempt.kind) {
      case 'issued':
        return { outcome: 'issued', message: null };
      case 'unsynced':
        return {
          outcome: 'waiting',
          message: 'They aren’t in Microsoft Entra now: their pass is made when they appear.',
        };
      case 'retry':
      case 'failed': {
        const kept = pass.status === 'issued' && held(pass, new Date());
        const message = kept
          ? `Their pass wasn’t replaced, so the one they have still stands: ${attempt.message}`
          : attempt.message;
        return { outcome: attempt.kind === 'retry' ? 'waiting' : 'failed', message };
      }
      case 'refused':
        return { outcome: 'refused', message: attempt.message };
    }
  }

  /**
   * Move class: every pass is made again for the new start, the values
   * held for the old one deleted. Refused, with nothing changed, when the
   * new start doesn't suit the tenant's policy for everyone.
   */
  async reschedule(job: JobRecord, start: ClassStart, actor: ClassPassActor): Promise<void> {
    const { db } = this.deps;
    const klass = await this.classOf(job);
    const graph = await this.deps.graph.build(job.provider_id);
    if (!graph) throw NotFound('This directory has no Microsoft Entra integration.');
    const policy = await tenantTapPolicy(graph);
    if (!policy) {
      throw new AppError({
        statusCode: 409,
        code: 'policy_disabled',
        message:
          'Temporary Access Pass is turned off in the tenant’s authentication methods policy. Turn it on in the Microsoft Entra admin center first.',
      });
    }
    const rows = await db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .select([
        'p.row_id',
        'r.target_id',
        'r.status as row_status',
        sql<string | null>`r.input_json->>'startDate'`.as('start_date'),
        sql<string | null>`r.input_json->>'line'`.as('line'),
      ])
      .where('p.job_id', '=', job.id)
      .execute();
    // Only the people who have, or may yet get, an account need a class.
    const attending = rows.filter(
      (r) => r.target_id !== null || r.row_status === 'pending' || r.row_status === 'running',
    );
    const classTap = {
      start,
      lifetimeMinutes: klass.lifetime_minutes,
      isUsableOnce: klass.is_usable_once,
    };
    const problems = classTapProblems(
      classTap,
      attending.map((r) => ({ startDate: r.start_date })),
      policy,
    ).map((p) =>
      p.row === null ? p.message : `Row ${attending[p.row]!.line ?? '?'}: ${p.message}`,
    );
    if (problems.length > 0) {
      throw new AppError({
        statusCode: 400,
        code: 'outside_policy',
        message: `${problems.slice(0, 3).join(' ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
      });
    }

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('import_classes')
        .set({ start: JSON.stringify(start), updated_at: sql`now()` })
        .where('job_id', '=', job.id)
        .execute();
      for (const r of rows) {
        await trx
          .updateTable('class_passes')
          .set({
            status: 'waiting',
            class_starts_at: classStartOf(start, r.start_date)?.toISOString() ?? null,
            pass_enc: null,
            entra_method_id: null,
            pass_starts_at: null,
            expires_at: null,
            error_code: null,
            message: null,
            attempts: 0,
            next_attempt_at: sql`now()`,
            // A pass being made for the old start can't be recorded now.
            claim_token: null,
            updated_at: sql`now()`,
          })
          .where('row_id', '=', r.row_id)
          .execute();
      }
      await this.deps.audit.recordEvent(
        {
          ...actor,
          action: 'import.class.reschedule',
          result: 'success',
          providerId: job.provider_id,
          bulkJobId: String(job.id),
          targetType: 'user',
          before: { start: klass.start },
          after: { start },
          metadata: { rows: rows.length },
        },
        trx,
      );
    });
    this.kick();
  }
}

class LostClaim extends Error {}

/** People still not in Entra with their class this close and not yet over. */
function unsyncedAlert(
  passes: readonly {
    status: string;
    class_starts_at: Date | string | null;
    target_id: string | null;
  }[],
  lifetimeMinutes: number,
  now: Date,
): ClassRoster['unsyncedAlert'] {
  const starts = passes.flatMap((p) => {
    if (p.status !== 'waiting' || !p.target_id || !p.class_starts_at) return [];
    const start = new Date(p.class_starts_at);
    const ongoing = tapExpiresAt(start, lifetimeMinutes) > now;
    return ongoing && nearClass(start, now) ? [start.getTime()] : [];
  });
  if (starts.length === 0) return null;
  return { count: starts.length, startsAt: new Date(Math.min(...starts)).toISOString() };
}

async function inBatches<T>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}
