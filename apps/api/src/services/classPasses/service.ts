// SPDX-License-Identifier: BUSL-1.1
// Class Temporary Access Passes: what an import with "Issue TAPs for
// class" leaves to do once its accounts exist. Why the values are stored,
// and for how long, is docs/adr/0003-class-taps-are-stored-until-they-expire.md.
//
// The follow-up runs in-process without the operator: Graph is called with
// the app's client credentials and AD read with the service account, never
// with an operator's password. It acts on the authority of the class's
// authoriser (the import's operator, or whoever took the class over or
// rescheduled it), checked every quarter of an hour: one who can no longer
// issue passes pauses the class. Each pass is made only for an account the
// import created, never for anyone who is or may be an administrator, and
// that is checked again before class and before each reveal: a holder who
// has become one has their pass deleted in Entra. A pass replaced (a
// reschedule, a reissue) is deleted in Entra before the new one is made,
// and a pass the class didn't make isn't replaced unasked.
//
// Its state is class_passes, so a restart carries on where it was: a due
// pass is claimed (claim_token) for a lease, and one whose process died
// is due again when the lease lapses. Graph throttling holds back that
// directory's passes for as long as Graph asks, and a directory with the
// feature off has its stored values deleted and nothing retried.
import { randomUUID } from 'node:crypto';
import {
  NO_START_DATE_MESSAGE,
  TAP_POLICY_OFF_MESSAGE,
  classStartOf,
  classTapProblems,
  type Capability,
  type ClassPassReissue,
  type ClassPassReveal,
  type ClassPassStatus,
  type ClassReschedule,
  type ClassRoster,
  type ClassStart,
  type ClassTapRequest,
} from '@openaduc/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import { z } from 'zod';
import type { ClassPassesTable, DB, ImportClassesTable } from '../../db/types.js';
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
  type GraphClient,
  type GraphClientFactory,
} from '../graphClient.js';
import {
  REFUSAL_CODES,
  TapNotEnabled,
  issueTap,
  tapPreflight,
  tapUserOf,
  tenantTapPolicy,
  type TapIssueCode,
} from '../temporaryAccessPass.js';
import { SweepTimer } from '../sweepTimer.js';
import { classAlerts, rosterRow, WAITING_CODES, type RosterPass } from './roster.js';
import {
  errorRetryMs,
  graphPassStatus,
  passSpent,
  passWindow,
  reachableAt,
  recheckAt,
  syncRetryMs,
} from './rules.js';

export interface ClassPassDeps {
  db: Kysely<DB>;
  audit: Pick<AuditService, 'recordEvent'>;
  entra: Pick<EntraIntegrationService, 'directoriesWith'>;
  graph: Pick<GraphClientFactory, 'tapGraph'>;
  providers: Pick<ProviderFactory, 'buildForDirectory'>;
  roleGroups: () => Promise<readonly RoleGroup[]>;
  /** What OpenADUC lets someone with these AD groups do, as at sign-in. */
  capabilitiesOf: (memberOfDns: readonly string[]) => Promise<Capability[]>;
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
/** How long what Graph said of a pass, or of the tenant's last sync, is shown again unasked. */
const STATUS_TTL_MS = 60_000;
/** How long an authoriser found able to issue passes, or not, is taken as such. */
const AUTHORITY_TTL_MS = 15 * 60_000;
const INSERT_CHUNK = 1_000;

const bindingOf = (jobId: string, rowId: string) => `class_passes:${jobId}:${rowId}`;
const methodsPath = (entraUserId: string) =>
  `/users/${encodeURIComponent(entraUserId)}/authentication/temporaryAccessPassMethods`;
const methodPath = (entraUserId: string, methodId: string) =>
  `${methodsPath(entraUserId)}/${encodeURIComponent(methodId)}`;

/** Why a pass isn't made, or is taken away: its holder is, or may be, an administrator. */
const REFUSALS = new Set<TapIssueCode>([
  'privileged',
  'entra_admin_role',
  'entra_roles_unknown',
  'membership_unknown',
]);

const OTHER_PASS =
  'They hold a Temporary Access Pass this class didn’t make. Reissue to replace it.';
const NOT_HELD = {
  issued:
    'OpenADUC no longer holds this pass: it expired, was used or replaced. Reissue it if they need another.',
  other: 'They have no pass to reveal.',
};
const OFF_PURGED =
  ' OpenADUC has deleted the passes it held for this class; those in Entra expire as they were set to.';

const livePassSchema = z.object({
  id: z.string().nullish(),
  methodUsabilityReason: z.string().nullish(),
});
type LivePass = z.infer<typeof livePassSchema>;

type Pass = Selectable<ClassPassesTable> & {
  target_id: string | null;
  target_dn: string | null;
  provider_id: number;
  lifetime_minutes: number;
  is_usable_once: boolean;
  authoriser_user_id: string;
  authoriser_display_name: string | null;
};
type PassUpdate = Updateable<ClassPassesTable>;

type Refusal = { code: TapIssueCode | 'not_found'; message: string };

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
  | { kind: 'later'; at: Date }
  | { kind: 'retry'; code: string; message: string; afterMs: number }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'failed'; code: string; message: string };

/** The fields an issued pass has, cleared when it's gone. */
const NO_PASS: PassUpdate = {
  pass_enc: null,
  entra_method_id: null,
  pass_starts_at: null,
  expires_at: null,
};

/** An audit event about a class (its job) or one of its passes (the person's account). */
function event(
  actor: ClassPassActor,
  action: string,
  result: 'success' | 'failure',
  on: { providerId: number; jobId: string; pass?: Pick<Pass, 'target_id' | 'target_dn'> },
  more: Partial<AuditEventInput> = {},
): AuditEventInput {
  return {
    ...actor,
    action,
    result,
    providerId: on.providerId,
    bulkJobId: on.jobId,
    ...(on.pass
      ? { targetType: 'user', targetId: on.pass.target_id, targetDn: on.pass.target_dn }
      : { targetType: 'system', targetId: on.jobId }),
    ...more,
  };
}

/**
 * Store the class an import's people get passes for, and a pass to make
 * for each of its rows, in the transaction that stores the job, on the
 * authority of the job's operator.
 */
export async function storeClass(
  trx: Kysely<DB>,
  jobId: string,
  classTap: ClassTapRequest,
): Promise<void> {
  const job = await trx
    .selectFrom('bulk_jobs')
    .select(['actor_user_id', 'actor_display_name'])
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('import_classes')
    .values({
      job_id: jobId,
      start: JSON.stringify(classTap.start),
      lifetime_minutes: classTap.lifetimeMinutes,
      is_usable_once: classTap.isUsableOnce,
      authoriser_user_id: job.actor_user_id,
      authoriser_display_name: job.actor_display_name,
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

const isHeld = (p: Pick<Pass, 'pass_enc' | 'expires_at'>, now: Date) =>
  p.pass_enc !== null && p.expires_at !== null && new Date(p.expires_at) > now;

const authoriserOf = (
  klass: Pick<ImportClassesTable, 'authoriser_user_id'> & {
    authoriser_display_name: string | null;
  },
): ClassPassActor => ({
  actorUserId: klass.authoriser_user_id,
  actorDisplayName: klass.authoriser_display_name,
  actorAuthMethod: 'system',
});

export class ClassPassService {
  private readonly timer: SweepTimer;
  /** Directories Graph has throttled, until when. */
  private readonly throttledUntil = new Map<number, number>();
  /** Whether an authoriser may still issue passes, by directory and user, as last found. */
  private readonly authority = new Map<string, { at: number; lapsed: string | null }>();
  /** What Graph last said of a person's pass, by Entra user, for the roster. */
  private readonly liveStatus = new Map<string, { at: number; pass: LivePass | null }>();
  private readonly lastSync = new Map<number, { at: number; value: string | null }>();
  /** Passes the roster saw Entra say are spent, for the next sweep to stop holding. */
  private readonly observedSpent = new Set<string>();

  constructor(private readonly deps: ClassPassDeps) {
    this.timer = new SweepTimer(() => this.sweep(), {
      tickMs: TICK_MS,
      stopWaitMs: STOP_WAIT_MS,
      onError: (err) => deps.logger.error({ err }, 'class passes tick failed'),
    });
  }

  start(): void {
    this.timer.start();
  }

  /** Stop the timer, letting a sweep under way finish (briefly). */
  stop(): Promise<void> {
    return this.timer.stop();
  }

  /** Sweep now, while the timer runs, rather than at its next tick. */
  kick(): void {
    this.timer.kick();
  }

  private throttled(directoryId: number, now = Date.now()): boolean {
    return (this.throttledUntil.get(directoryId) ?? 0) > now;
  }

  /**
   * Stop holding what needn't be held (expired passes, those the roster
   * saw spent, every pass of a directory whose feature is off), check
   * each class's authoriser, then work through the due passes until none
   * are or the tick's time is up. Returns how many were taken.
   */
  async sweep(budgetMs = TICK_BUDGET_MS): Promise<number> {
    const { db } = this.deps;
    const on = await this.deps.entra.directoriesWith('temporaryAccessPass');
    await db
      .updateTable('class_passes')
      .set({ pass_enc: null, updated_at: sql`now()` })
      .where('pass_enc', 'is not', null)
      .where((eb) =>
        eb.or([
          eb('expires_at', '<=', sql<Date>`now()`),
          eb(
            'job_id',
            'in',
            eb
              .selectFrom('bulk_jobs')
              .select('id')
              .where(sql<boolean>`NOT (provider_id = ANY(${on}::int[]))`),
          ),
          ...(this.observedSpent.size > 0 ? [eb('row_id', 'in', [...this.observedSpent])] : []),
        ]),
      )
      .execute();
    this.observedSpent.clear();
    await this.checkAuthority(on);

    const until = Date.now() + budgetMs;
    let taken = 0;
    while (Date.now() < until && !this.timer.stopping) {
      const claimed = await this.claimDue(on);
      if (!claimed) break;
      taken++;
      const { pass, token } = claimed;
      if (pass.status === 'issued') await this.recheck(pass, token);
      else {
        await this.make(pass, token, authoriserOf(pass), {
          action: 'import.classPass.issue',
          replaceExisting: false,
          auditWaits: false,
        });
      }
    }
    return taken;
  }

  /** Whether the authoriser may still issue passes; null when the directory couldn't say. */
  private async lapse(directoryId: number, userId: string, name: string | null) {
    const key = `${directoryId}:${userId}`;
    const known = this.authority.get(key);
    if (known && Date.now() - known.at < AUTHORITY_TTL_MS) return known.lapsed;
    const who = name ?? 'The operator these passes are made for';
    let why: string | null;
    try {
      const directory = await this.deps.providers.buildForDirectory(directoryId);
      const user = await directory.getUser({ kind: 'objectGuid', value: userId });
      if (!user) why = 'their account is no longer in the directory';
      else if (!user.enabled) why = 'their account is disabled';
      else {
        const caps = await this.deps.capabilitiesOf(user.memberOfDns);
        why = caps.includes('write:user.issueTap') ? null : 'their role no longer allows it';
      }
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return undefined;
      throw err;
    }
    const lapsed = why
      ? `${who} can no longer issue passes (${why}). Another operator can take over.`
      : null;
    this.authority.set(key, { at: Date.now(), lapsed });
    return lapsed;
  }

  /** Pause each class whose authoriser can no longer issue passes, and resume one whose can again. */
  private async checkAuthority(on: readonly number[]): Promise<void> {
    if (on.length === 0) return;
    const classes = await this.deps.db
      .selectFrom('import_classes as c')
      .innerJoin('bulk_jobs as j', 'j.id', 'c.job_id')
      .select([
        'c.job_id',
        'c.authoriser_user_id',
        'c.authoriser_display_name',
        'c.authority_lapsed_at',
        'j.provider_id',
      ])
      .where(sql<boolean>`j.provider_id = ANY(${on}::int[])`)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('class_passes as p')
            .select('p.row_id')
            .whereRef('p.job_id', '=', 'c.job_id')
            .where('p.status', '=', 'waiting'),
        ),
      )
      .execute();
    for (const c of classes) {
      const lapsed = await this.lapse(
        c.provider_id,
        c.authoriser_user_id,
        c.authoriser_display_name,
      );
      if (lapsed === undefined || (lapsed !== null) === (c.authority_lapsed_at !== null)) continue;
      await this.deps.db
        .updateTable('import_classes')
        .set({
          authority_lapsed_at: lapsed ? sql`now()` : null,
          authority_message: lapsed,
          updated_at: sql`now()`,
        })
        .where('job_id', '=', c.job_id)
        .where('authoriser_user_id', '=', c.authoriser_user_id)
        .execute();
      await this.deps.audit.recordEvent(
        event(
          authoriserOf(c),
          lapsed ? 'import.class.pause' : 'import.class.resume',
          'success',
          { providerId: c.provider_id, jobId: String(c.job_id) },
          lapsed ? { metadata: { reason: lapsed } } : {},
        ),
      );
    }
  }

  /**
   * Claim the next due pass: one to make, whose account the import has
   * created and whose class isn't paused; or an issued one to check again.
   */
  private async claimDue(on: readonly number[]): Promise<{ pass: Pass; token: string } | null> {
    if (on.length === 0) return null;
    const now = Date.now();
    const throttled = [...this.throttledUntil].flatMap(([id, at]) => (at > now ? [id] : []));
    const token = randomUUID();
    const { rows } = await sql<{ row_id: string }>`
      UPDATE class_passes SET claim_token = ${token},
        attempts = CASE WHEN status = 'waiting' THEN attempts + 1 ELSE attempts END,
        next_attempt_at = ${LEASE}, updated_at = now()
      WHERE row_id = (
        SELECT p.row_id FROM class_passes p
        JOIN bulk_job_rows r ON r.id = p.row_id
        JOIN bulk_jobs j ON j.id = p.job_id
        JOIN import_classes c ON c.job_id = p.job_id
        WHERE p.next_attempt_at <= now()
          AND j.provider_id = ANY(${on}::int[])
          AND NOT (j.provider_id = ANY(${throttled}::int[]))
          AND (
            (p.status = 'waiting' AND c.authority_lapsed_at IS NULL
              AND r.target_id IS NOT NULL AND r.status IN ('succeeded', 'partial'))
            OR (p.status = 'issued' AND p.pass_enc IS NOT NULL AND p.expires_at > now())
          )
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
        'c.lifetime_minutes',
        'c.is_usable_once',
        'c.authoriser_user_id',
        'c.authoriser_display_name',
      ])
      .where('p.row_id', '=', rowId);
    if (jobId) q = q.where('p.job_id', '=', jobId);
    return (await q.executeTakeFirst()) ?? null;
  }

  /** Change a pass this run has claimed, letting the claim go. False when it lost the claim. */
  private async update(
    pass: Pass,
    token: string | null,
    set: PassUpdate,
    db: Kysely<DB> = this.deps.db,
  ): Promise<boolean> {
    let q = db
      .updateTable('class_passes')
      .set({ ...set, claim_token: null, updated_at: sql`now()` })
      .where('row_id', '=', pass.row_id);
    if (token) q = q.where('claim_token', '=', token);
    return Number((await q.executeTakeFirst()).numUpdatedRows) > 0;
  }

  /**
   * Whether the pass's holder may have it: their account still exists and
   * they aren't, and can't be, an administrator, as Issue TAP decides.
   * Throws what a check that couldn't be made throws.
   */
  private async privilege(
    pass: Pass,
    graph: GraphClient,
  ): Promise<{ refusal: Refusal | null; current: LivePass | null }> {
    const directory = await this.deps.providers.buildForDirectory(pass.provider_id);
    const id = { kind: 'objectGuid' as const, value: pass.target_id! };
    const user = await directory.getUser(id);
    if (!user) {
      return {
        refusal: { code: 'not_found', message: 'The account is no longer in the directory.' },
        current: null,
      };
    }
    const { preflight, passes } = await tapPreflight(
      {
        graph,
        tokenGroups: () => directory.getUserTokenGroups(id),
        roleGroups: await this.deps.roleGroups(),
      },
      tapUserOf(user),
    );
    const code = preflight.status === 'refused' ? REFUSAL_CODES[preflight.reason] : null;
    return {
      refusal:
        code && REFUSALS.has(code) && preflight.status === 'refused'
          ? { code, message: preflight.message }
          : null,
      current: passes?.[0] ?? null,
    };
  }

  /**
   * Take a pass away from someone who may no longer hold it: deleted in
   * Entra, its value deleted, the person refused with the reason.
   */
  private async revoke(
    pass: Pass,
    token: string | null,
    refusal: Refusal,
    actor: ClassPassActor,
    graph: GraphClient | null,
  ): Promise<void> {
    let deleted = !pass.entra_method_id;
    if (graph && pass.entra_user_id && pass.entra_method_id) {
      deleted = await graph
        .delete(methodPath(pass.entra_user_id, pass.entra_method_id))
        .then(() => true)
        .catch((err: unknown) => {
          this.deps.logger.warn({ err, rowId: pass.row_id }, 'deleting a class pass failed');
          return false;
        });
    }
    await this.update(pass, token, {
      status: 'refused',
      ...NO_PASS,
      error_code: refusal.code,
      message: deleted
        ? refusal.message
        : `${refusal.message} OpenADUC couldn’t delete their pass in Entra: delete it in the Microsoft Entra admin center.`,
      next_attempt_at: new Date().toISOString(),
    });
    await this.deps.audit.recordEvent(
      event(
        actor,
        'import.classPass.revoke',
        'success',
        { providerId: pass.provider_id, jobId: String(pass.job_id), pass },
        { errorCode: refusal.code, metadata: { reason: refusal.message, entraDeleted: deleted } },
      ),
    );
  }

  /** Check an issued pass's holder again, and stop holding a pass Entra says is spent. */
  private async recheck(pass: Pass, token: string): Promise<void> {
    const now = new Date();
    const graph = await this.deps.graph.tapGraph(pass.provider_id);
    if (!graph) {
      await this.update(pass, token, { next_attempt_at: new Date().toISOString() });
      return;
    }
    try {
      const { refusal, current } = await this.privilege(pass, graph);
      if (refusal) {
        await this.revoke(pass, token, refusal, authoriserOf(pass), graph);
        return;
      }
      await this.update(pass, token, {
        ...(passSpent(current, pass.entra_method_id) ? { pass_enc: null } : {}),
        next_attempt_at: recheckAt(
          pass.class_starts_at ? new Date(pass.class_starts_at) : null,
          now,
        ).toISOString(),
      });
    } catch (err) {
      const afterMs = this.retryAfter(err, pass);
      await this.update(pass, token, {
        next_attempt_at: new Date(now.getTime() + afterMs).toISOString(),
      });
    }
  }

  /** How long to wait after a check or a make that couldn't be made; logs the unexpected. */
  private retryAfter(err: unknown, pass: Pass): number {
    if (err instanceof GraphThrottledError) {
      const ms = Math.max(30_000, err.retryAfterSeconds * 1000);
      this.throttledUntil.set(pass.provider_id, Date.now() + ms);
      return ms;
    }
    if (!(err instanceof GraphPermissionError || err instanceof DirectoryUnavailableError)) {
      this.deps.logger.error({ err, rowId: pass.row_id }, 'class pass work failed');
    }
    return errorRetryMs(Math.max(1, pass.attempts));
  }

  /**
   * Make one claimed pass and record how it went: the pass a reschedule
   * or reissue replaced deleted in Entra first, then the new one made.
   */
  private async make(
    pass: Pass,
    token: string,
    actor: ClassPassActor,
    how: { action: string; replaceExisting: boolean; auditWaits: boolean },
  ): Promise<Attempt> {
    const now = new Date();
    const graph = await this.deps.graph.tapGraph(pass.provider_id);
    let attempt: Attempt;
    if (!graph) {
      attempt = {
        kind: 'retry',
        code: 'tap_not_enabled',
        message: 'Temporary Access Pass is turned off for this directory.',
        afterMs: errorRetryMs(pass.attempts),
      };
    } else {
      const stale = pass.stale_method_id && pass.entra_user_id;
      const notDeleted = stale
        ? await graph
            .delete(methodPath(pass.entra_user_id!, pass.stale_method_id!))
            .then(() => null)
            .catch((err: unknown) => err)
        : null;
      if (notDeleted) {
        attempt = {
          kind: 'retry',
          code: notDeleted instanceof GraphThrottledError ? 'entra_throttled' : 'stale_not_deleted',
          message: 'Their previous pass couldn’t be deleted in Entra, so no new one is made yet.',
          afterMs: this.retryAfter(notDeleted, pass),
        };
      } else {
        if (stale) {
          await this.deps.db
            .updateTable('class_passes')
            .set({ stale_method_id: null })
            .where('row_id', '=', pass.row_id)
            .where('claim_token', '=', token)
            .execute();
        }
        attempt = await this.attempt(pass, graph, now, how.replaceExisting);
      }
    }
    return this.record(pass, token, attempt, now, actor, how, graph);
  }

  private async attempt(
    pass: Pass,
    graph: GraphClient,
    now: Date,
    replaceExisting: boolean,
  ): Promise<Attempt> {
    const failed = (code: string, message: string): Attempt => ({ kind: 'failed', code, message });
    if (!pass.class_starts_at) {
      return failed('no_start', NO_START_DATE_MESSAGE);
    }
    const classStart = new Date(pass.class_starts_at);
    const window = passWindow(classStart, pass.lifetime_minutes, now);
    if (!window) {
      return failed(
        'class_over',
        'Class was over before their pass could be made. Reschedule class to give them one.',
      );
    }
    const reachable = reachableAt(classStart);
    if (reachable > now) return { kind: 'later', at: reachable };

    try {
      const directory = await this.deps.providers.buildForDirectory(pass.provider_id);
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
          replaceExisting,
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
      if (outcome.code === 'tap_exists') return failed('other_pass', OTHER_PASS);
      return REFUSALS.has(outcome.code)
        ? { kind: 'refused', code: outcome.code, message: outcome.message }
        : failed(outcome.code, outcome.message);
    } catch (err) {
      if (err instanceof GraphPermissionError && err.statusCode === 400) {
        return failed(
          'entra_rejected',
          `Microsoft Entra refused: ${err.graphMessage ?? err.message}`,
        );
      }
      const message =
        err instanceof GraphThrottledError
          ? 'Microsoft Graph is busy.'
          : err instanceof GraphPermissionError
            ? err.hint
              ? `${err.message} (${err.hint})`
              : err.message
            : err instanceof DirectoryUnavailableError
              ? 'No domain controller could be reached.'
              : 'Something went wrong making their pass.';
      const code =
        err instanceof GraphThrottledError
          ? 'entra_throttled'
          : err instanceof GraphPermissionError
            ? 'entra_error'
            : err instanceof DirectoryUnavailableError
              ? 'directory_unavailable'
              : 'internal_error';
      return { kind: 'retry', code, message, afterMs: this.retryAfter(err, pass) };
    }
  }

  /**
   * Record how making a pass went. A made pass is stored with its audit
   * row, together; if that can't be done, the pass is deleted in Entra
   * again and the row tried again later, so no pass is live that nobody
   * holds. Returns what came of it, which a storage failure makes a retry.
   */
  private async record(
    pass: Pass,
    token: string,
    attempt: Attempt,
    now: Date,
    actor: ClassPassActor,
    how: { action: string; auditWaits: boolean },
    graph: GraphClient | null,
  ): Promise<Attempt> {
    const rowId = String(pass.row_id);
    const jobId = String(pass.job_id);
    const on = { providerId: pass.provider_id, jobId, pass };
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const classStart = pass.class_starts_at ? new Date(pass.class_starts_at) : null;

    switch (attempt.kind) {
      case 'issued': {
        const stored = await this.deps.db
          .transaction()
          .execute(async (trx) => {
            const claimed = await this.update(
              pass,
              token,
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
                next_attempt_at: recheckAt(classStart, now).toISOString(),
              },
              trx,
            );
            if (!claimed) throw new LostClaim();
            await this.deps.audit.recordEvent(
              event(actor, how.action, 'success', on, {
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
            return true;
          })
          .catch((err: unknown) => {
            if (!(err instanceof LostClaim)) {
              this.deps.logger.error({ err, rowId }, 'storing a class pass failed');
            }
            return false;
          });
        if (stored) return attempt;
        // Nobody holds the pass just made: it mustn't stay live.
        const deleted =
          !!graph &&
          !!attempt.methodId &&
          (await graph
            .delete(methodPath(attempt.entraUserId, attempt.methodId))
            .then(() => true)
            .catch(() => false));
        const failure: Attempt = {
          kind: 'retry',
          code: 'store_failed',
          message: deleted
            ? 'Their pass couldn’t be stored, so it was deleted in Entra. It’s made again shortly.'
            : 'Their pass couldn’t be stored, and couldn’t be deleted in Entra. It’s made again shortly.',
          afterMs: errorRetryMs(pass.attempts),
        };
        await this.update(pass, token, {
          status: 'waiting',
          ...NO_PASS,
          entra_user_id: attempt.entraUserId,
          stale_method_id: deleted ? null : attempt.methodId,
          error_code: failure.code,
          message: failure.message,
          next_attempt_at: at(failure.afterMs),
        });
        await this.deps.audit
          .recordEvent(event(actor, how.action, 'failure', on, { errorCode: failure.code }))
          .catch((err) => this.deps.logger.error({ err }, 'audit insert failed'));
        return failure;
      }
      case 'unsynced':
        await this.update(pass, token, {
          status: 'waiting',
          ...NO_PASS,
          error_code: WAITING_CODES.unsynced,
          message: null,
          tenant_last_sync_at: attempt.lastSyncAt,
          next_attempt_at: at(syncRetryMs(pass.attempts, classStart, now)),
        });
        break;
      case 'later':
        await this.update(pass, token, {
          status: 'waiting',
          error_code: WAITING_CODES.notYet,
          message: null,
          next_attempt_at: attempt.at.toISOString(),
        });
        break;
      case 'retry':
        await this.update(pass, token, {
          status: 'waiting',
          error_code: attempt.code,
          message: attempt.message,
          next_attempt_at: at(attempt.afterMs),
        });
        break;
      case 'refused':
      case 'failed':
        await this.update(pass, token, {
          status: attempt.kind,
          ...NO_PASS,
          error_code: attempt.code,
          message: attempt.message,
          next_attempt_at: now.toISOString(),
        });
        await this.deps.audit.recordEvent(
          event(actor, how.action, 'failure', on, {
            errorCode: attempt.code,
            metadata: { message: attempt.message },
          }),
        );
        return attempt;
    }
    if (how.auditWaits) {
      const code = attempt.kind === 'retry' ? attempt.code : (attempt.kind as string);
      await this.deps.audit.recordEvent(
        event(actor, how.action, 'failure', on, { errorCode: code }),
      );
    }
    return attempt;
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

  private async alertsFor(
    jobId: string,
    providerId: number,
    klass: Selectable<ImportClassesTable>,
    passes: Parameters<typeof classAlerts>[0],
  ) {
    const on = (await this.deps.entra.directoriesWith('temporaryAccessPass')).includes(
      Number(providerId),
    );
    return classAlerts(
      passes,
      {
        lifetimeMinutes: klass.lifetime_minutes,
        authority:
          klass.authority_lapsed_at && klass.authority_message
            ? { name: klass.authoriser_display_name, message: klass.authority_message }
            : null,
        off: on
          ? null
          : `Temporary Access Pass is turned off for this directory, so no passes are made.${OFF_PURGED}`,
      },
      new Date(),
    );
  }

  /** The class's alerts, for the import's page; null when it didn't schedule one. */
  async alertOf(
    jobId: string,
    providerId: number,
  ): Promise<{ alerts: ClassRoster['alerts'] } | null> {
    const klass = await this.deps.db
      .selectFrom('import_classes')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    if (!klass) return null;
    const passes = await this.deps.db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .select(['p.status', 'p.class_starts_at', 'p.error_code', 'p.message', 'r.target_id'])
      .where('p.job_id', '=', jobId)
      .execute();
    return { alerts: await this.alertsFor(jobId, providerId, klass, passes) };
  }

  /** What Graph says of a person's pass, asked at most once a minute and never while it's throttled. */
  private async livePass(
    graph: GraphClient,
    providerId: number,
    entraUserId: string,
  ): Promise<LivePass | null | undefined> {
    const known = this.liveStatus.get(entraUserId);
    if (known && Date.now() - known.at < STATUS_TTL_MS) return known.pass;
    if (this.throttled(providerId)) return undefined;
    const res = await graph.getJson(methodsPath(entraUserId));
    const pass = listOf(livePassSchema).parse(res.data).value[0] ?? null;
    this.liveStatus.set(entraUserId, { at: Date.now(), pass });
    return pass;
  }

  private async tenantSync(graph: GraphClient | null, providerId: number) {
    if (!graph) return null;
    const known = this.lastSync.get(providerId);
    if (known && Date.now() - known.at < STATUS_TTL_MS) return known.value;
    if (this.throttled(providerId)) return known?.value ?? null;
    const value = await tenantLastSync(graph);
    this.lastSync.set(providerId, { at: Date.now(), value });
    return value;
  }

  /**
   * The class roster: each person, how their pass stands in Entra, and
   * whether it's held. It writes nothing: a pass Entra says is spent is
   * shown as not held, and the next sweep stops holding it.
   */
  async roster(job: JobRecord, readerId: string): Promise<ClassRoster> {
    const klass = await this.classOf(job);
    const graph = await this.deps.graph.tapGraph(job.provider_id);
    const now = new Date();
    const passes = await this.deps.db
      .selectFrom('class_passes as p')
      .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
      .selectAll('p')
      .select(['r.status as row_status', 'r.target_id', 'r.input_json', 'r.error_message'])
      .where('p.job_id', '=', job.id)
      .orderBy('r.ordinal')
      .execute();

    let statusError: string | null = null;
    const live = new Map<string, { status: ClassPassStatus; message: string | null }>();
    const spent = new Set<string>();
    if (graph) {
      const issued = passes.filter(
        (p) =>
          p.status === 'issued' && p.entra_user_id && p.expires_at && new Date(p.expires_at) > now,
      );
      for (let i = 0; i < issued.length; i += STATUS_READS) {
        await Promise.all(
          issued.slice(i, i + STATUS_READS).map(async (p) => {
            const rowId = String(p.row_id);
            try {
              const current = await this.livePass(graph, job.provider_id, p.entra_user_id!);
              if (current === undefined) {
                statusError = 'Microsoft Graph is busy, so some passes show what their times say.';
                return;
              }
              live.set(rowId, graphPassStatus(current, p.entra_method_id));
              if (passSpent(current, p.entra_method_id) && p.pass_enc) {
                spent.add(rowId);
                this.observedSpent.add(rowId);
              }
            } catch (err) {
              if (err instanceof GraphThrottledError) {
                this.throttledUntil.set(job.provider_id, Date.now() + err.retryAfterSeconds * 1000);
                statusError = 'Microsoft Graph is busy, so some passes show what their times say.';
              } else if (err instanceof GraphPermissionError) {
                statusError = `OpenADUC couldn’t ask Entra how the passes stand: ${err.message}`;
              } else throw err;
            }
          }),
        );
      }
    }

    const paused = !graph || klass.authority_lapsed_at !== null;
    const rows = passes.map((p) =>
      rosterRow(
        {
          ...p,
          row_id: String(p.row_id),
          held: !!graph && isHeld(p, now) && !spent.has(String(p.row_id)),
        } satisfies RosterPass,
        { lifetimeMinutes: klass.lifetime_minutes, paused, live: live.get(String(p.row_id)), now },
      ),
    );
    return {
      job: {
        id: String(job.id),
        actorDisplayName: job.actor_display_name,
        createdAt: new Date(job.created_at).toISOString(),
        own: job.actor_user_id === readerId,
      },
      class: {
        start: klass.start,
        lifetimeMinutes: klass.lifetime_minutes,
        isUsableOnce: klass.is_usable_once,
        updatedAt: new Date(klass.updated_at).toISOString(),
      },
      authoriser: {
        name: klass.authoriser_display_name,
        own: klass.authoriser_user_id === readerId,
      },
      lastSyncAt: await this.tenantSync(graph, job.provider_id).catch(() => null),
      alerts: await this.alertsFor(String(job.id), job.provider_id, klass, passes),
      statusError,
      rows: rows.sort((a, b) => a.line - b.line),
    };
  }

  /**
   * A held pass's value, once its holder is found still not an
   * administrator: one who has become one, or can't be cleared, has the
   * pass taken away instead. Every reveal, and every refusal, is audited;
   * the value never is.
   */
  async reveal(job: JobRecord, rowId: string, actor: ClassPassActor): Promise<ClassPassReveal> {
    const pass = await this.load(rowId, String(job.id));
    if (!pass) throw NotFound('That person isn’t on this class roster.');
    const on = { providerId: job.provider_id, jobId: String(job.id), pass };
    const refuse = async (error: AppError): Promise<never> => {
      await this.deps.audit.recordEvent(
        event(actor, 'import.classPass.reveal', 'failure', on, { errorCode: error.code }),
      );
      throw error;
    };
    const now = new Date();
    if (pass.status !== 'issued' || !isHeld(pass, now) || this.observedSpent.has(rowId)) {
      return refuse(
        new AppError({
          statusCode: 410,
          code: 'gone',
          message: pass.status === 'issued' ? NOT_HELD.issued : NOT_HELD.other,
        }),
      );
    }
    const graph = await this.deps.graph.tapGraph(job.provider_id);
    if (!graph) throw TapNotEnabled();
    let refusal: Refusal | null;
    try {
      ({ refusal } = await this.privilege(pass, graph));
    } catch (err) {
      if (err instanceof GraphThrottledError) this.retryAfter(err, pass);
      return refuse(
        new AppError({
          statusCode: 503,
          code: 'unverified',
          message:
            'OpenADUC couldn’t check that they still aren’t an administrator, so it doesn’t reveal their pass. Try again in a minute.',
        }),
      );
    }
    if (refusal) {
      await this.revoke(pass, null, refusal, actor, graph);
      return refuse(
        new AppError({
          statusCode: 409,
          code: refusal.code,
          message: `${refusal.message} Their pass has been deleted.`,
        }),
      );
    }
    const value = decryptSecret(pass.pass_enc!, bindingOf(String(job.id), rowId));
    const startsAt = new Date(pass.pass_starts_at ?? pass.class_starts_at!).toISOString();
    const expiresAt = new Date(pass.expires_at!).toISOString();
    // Audited before it's handed over: a reveal that can't be audited doesn't happen.
    await this.deps.audit.recordEvent(
      event(actor, 'import.classPass.reveal', 'success', on, { metadata: { startsAt, expiresAt } }),
    );
    return { temporaryAccessPass: value, startsAt, expiresAt, isUsableOnce: pass.is_usable_once };
  }

  /**
   * Make one person's pass again, now, for the class as scheduled: the
   * pass they hold is deleted in Entra first and its value with it, then
   * a new one made, replacing any pass the class didn't make, which the
   * operator confirmed. Audited as the operator's, whatever came of it.
   */
  async reissue(job: JobRecord, rowId: string, actor: ClassPassActor): Promise<ClassPassReissue> {
    await this.classOf(job);
    const before = await this.load(rowId, String(job.id));
    if (!before) throw NotFound('That person isn’t on this class roster.');
    if (!before.target_id) {
      throw new AppError({
        statusCode: 409,
        code: 'not_created',
        message: 'The import hasn’t created their account, so there’s no one to give a pass to.',
      });
    }
    const token = randomUUID();
    const claimed = await this.deps.db
      .updateTable('class_passes')
      .set({
        claim_token: token,
        attempts: 1,
        next_attempt_at: LEASE,
        status: 'waiting',
        stale_method_id: sql`COALESCE(entra_method_id, stale_method_id)`,
        ...NO_PASS,
        error_code: null,
        message: null,
        updated_at: sql`now()`,
      })
      .where('row_id', '=', rowId)
      .where('job_id', '=', job.id)
      .where((eb) =>
        eb.or([eb('claim_token', 'is', null), eb('next_attempt_at', '<=', sql<Date>`now()`)]),
      )
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) {
      throw new AppError({
        statusCode: 409,
        code: 'class_pass_busy',
        message: 'Their pass is being made right now. Try again in a moment.',
      });
    }
    const pass = (await this.load(rowId, String(job.id)))!;
    const attempt = await this.make(pass, token, actor, {
      action: 'import.classPass.reissue',
      replaceExisting: true,
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
      case 'later':
        return {
          outcome: 'waiting',
          message: 'Class is more than 30 days off: their pass is made once it’s within reach.',
        };
      case 'retry':
        return {
          // Made, but not stored, so deleted again: it didn't happen.
          outcome: attempt.code === 'store_failed' ? 'failed' : 'waiting',
          message: attempt.message,
        };
      case 'failed':
      case 'refused':
        return { outcome: attempt.kind, message: attempt.message };
    }
  }

  /**
   * Move class: each person whose new start hasn't passed gets their pass
   * made again for it, the one they hold deleted in Entra first and its
   * value now; those whose new start has passed are left as they were and
   * said. Rescheduling makes the operator the class's authoriser.
   */
  async reschedule(
    job: JobRecord,
    start: ClassStart,
    actor: ClassPassActor,
  ): Promise<ClassReschedule> {
    const { db } = this.deps;
    const klass = await this.classOf(job);
    const graph = await this.deps.graph.tapGraph(job.provider_id);
    if (!graph) throw TapNotEnabled();
    const policy = await tenantTapPolicy(graph);
    if (!policy) {
      throw new AppError({
        statusCode: 409,
        code: 'policy_disabled',
        message: TAP_POLICY_OFF_MESSAGE,
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
        sql<string | null>`r.input_json->>'displayName'`.as('display_name'),
      ])
      .where('p.job_id', '=', job.id)
      .execute();
    // Only the people who have, or may yet get, an account need a class.
    const attending = rows.filter(
      (r) => r.target_id !== null || r.row_status === 'pending' || r.row_status === 'running',
    );
    const problems = classTapProblems(
      { start, lifetimeMinutes: klass.lifetime_minutes, isUsableOnce: klass.is_usable_once },
      attending.map((r) => ({ startDate: r.start_date })),
      policy,
    );
    const whole = problems.find((p) => p.row === null);
    if (whole)
      throw new AppError({ statusCode: 400, code: 'outside_policy', message: whole.message });
    const skippedRows = new Map(problems.map((p) => [attending[p.row!]!.row_id, p.message]));
    const moving = attending.filter((r) => !skippedRows.has(r.row_id));
    if (moving.length === 0) {
      throw new AppError({
        statusCode: 400,
        code: 'outside_policy',
        message: `Nobody’s class can start then: ${problems[0]?.message ?? ''}`,
      });
    }
    const authoriser = {
      authoriser_user_id: actor.actorUserId!,
      authoriser_display_name: actor.actorDisplayName ?? null,
    };

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('import_classes')
        .set({
          start: JSON.stringify(start),
          ...authoriser,
          authority_lapsed_at: null,
          authority_message: null,
          updated_at: sql`now()`,
        })
        .where('job_id', '=', job.id)
        .execute();
      for (const r of moving) {
        await trx
          .updateTable('class_passes')
          .set({
            status: 'waiting',
            class_starts_at: classStartOf(start, r.start_date)?.toISOString() ?? null,
            stale_method_id: sql`COALESCE(entra_method_id, stale_method_id)`,
            ...NO_PASS,
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
        event(
          actor,
          'import.class.reschedule',
          'success',
          { providerId: job.provider_id, jobId: String(job.id) },
          {
            before: { start: klass.start, authoriser: klass.authoriser_display_name },
            after: { start, authoriser: authoriser.authoriser_display_name },
            metadata: { rescheduled: moving.length, skipped: skippedRows.size },
          },
        ),
        trx,
      );
    });
    this.kick();
    return {
      rescheduled: moving.length,
      skipped: attending
        .filter((r) => skippedRows.has(r.row_id))
        .map((r) => ({
          rowId: String(r.row_id),
          line: Number(r.line),
          displayName: r.display_name ?? '',
          message: skippedRows.get(r.row_id)!,
        })),
    };
  }

  /** Make the operator the one the class's passes are made on behalf of, resuming a paused class. */
  async takeOver(job: JobRecord, actor: ClassPassActor): Promise<void> {
    const klass = await this.classOf(job);
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('import_classes')
        .set({
          authoriser_user_id: actor.actorUserId!,
          authoriser_display_name: actor.actorDisplayName ?? null,
          authority_lapsed_at: null,
          authority_message: null,
          updated_at: sql`now()`,
        })
        .where('job_id', '=', job.id)
        .execute();
      await this.deps.audit.recordEvent(
        event(
          actor,
          'import.class.takeOver',
          'success',
          { providerId: job.provider_id, jobId: String(job.id) },
          {
            before: { authoriser: klass.authoriser_display_name },
            after: { authoriser: actor.actorDisplayName ?? null },
          },
        ),
        trx,
      );
    });
    this.kick();
  }
}

class LostClaim extends Error {}
