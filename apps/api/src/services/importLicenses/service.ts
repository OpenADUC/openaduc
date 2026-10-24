// SPDX-License-Identifier: BUSL-1.1
// The license follow-up an import leaves when its groups grant licenses:
// once each person's account exists and Connect Sync has brought them to
// Entra, read their licenseAssignmentStates until each license their
// groups grant is listed (assigned, or with the error that stopped it),
// within a bounded window, so the import's page and CSV can say who
// didn't get what and why. Group-based licensing reports these errors on
// the user, minutes after sync, never to the import.
//
// It only reads: Graph with the app's client credentials, the cache for
// each person's SID. Its state is import_license_checks, so a restart
// carries on where it was: a due check is claimed (claim_token) for a
// lease, and one whose process died is due again when the lease lapses.
// Graph throttling holds back that directory's checks for as long as
// Graph asks; a directory with the feature off is left until it's on.
import { randomUUID } from 'node:crypto';
import type { ImportRowLicenses } from '@openaduc/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB, ImportLicenseChecksTable } from '../../db/types.js';
import { licenseSku } from '../../lib/skuNames.js';
import type { ProviderFactory } from '../../providers/registry.js';
import { DirectoryUnavailableError } from '../../providers/types.js';
import { progressOf } from '../bulkJobs/importRows.js';
import { assignmentStates } from '../entraLicenses.js';
import { findEntraUser } from '../entraLookup.js';
import type { EntraIntegrationService } from '../entraIntegration.js';
import {
  GraphPermissionError,
  GraphThrottledError,
  type GraphClientFactory,
} from '../graphClient.js';
import { SweepTimer } from '../sweepTimer.js';
import { licensedGroupsById } from './check.js';
import {
  checkedLicenses,
  lower,
  retryMs,
  settleOutcome,
  syncOutcome,
  type CheckOutcome,
} from './rules.js';

export interface ImportLicenseDeps {
  db: Kysely<DB>;
  entra: Pick<EntraIntegrationService, 'directoriesWith'>;
  graph: Pick<GraphClientFactory, 'build'>;
  providers: Pick<ProviderFactory, 'buildForDirectory'>;
  logger: FastifyBaseLogger;
}

const TICK_MS = 30_000;
const TICK_BUDGET_MS = 25_000;
const STOP_WAIT_MS = 4_000;
/** How long a claimed check is the claimer's before another process may take it. */
const LEASE = sql<Date>`now() + interval '10 minutes'`;
const INSERT_CHUNK = 1_000;

type Check = Selectable<ImportLicenseChecksTable> & {
  target_id: string | null;
  after_json: Record<string, unknown> | null;
  provider_id: number;
};
type CheckUpdate = Updateable<ImportLicenseChecksTable>;

/**
 * Store a license check for each of the job's rows whose groups grant a
 * license, with those groups as the cache has them now, in the
 * transaction that stores the job.
 */
export async function storeLicenseChecks(trx: Kysely<DB>, jobId: string): Promise<void> {
  const job = await trx
    .selectFrom('bulk_jobs')
    .select('provider_id')
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  const rows = await trx
    .selectFrom('bulk_job_rows')
    .select(['id', sql<string[] | null>`input_json->'groupIds'`.as('group_ids')])
    .where('job_id', '=', jobId)
    .execute();
  const licensed = await licensedGroupsById(trx, job.provider_id, [
    ...new Set(rows.flatMap((r) => (r.group_ids ?? []).map(lower))),
  ]);
  const checks = rows.flatMap((r) => {
    const expected = (r.group_ids ?? []).flatMap((id) => {
      const g = licensed.get(lower(id));
      return g
        ? [
            {
              groupId: g.id,
              entraGroupId: g.entraGroupId,
              name: g.name,
              skus: g.skus.map((s) => ({ skuId: s.skuId, skuPartNumber: s.skuPartNumber })),
            },
          ]
        : [];
    });
    return expected.length > 0
      ? [{ row_id: r.id, job_id: jobId, expected: JSON.stringify(expected) }]
      : [];
  });
  for (let i = 0; i < checks.length; i += INSERT_CHUNK) {
    await trx
      .insertInto('import_license_checks')
      .values(checks.slice(i, i + INSERT_CHUNK))
      .execute();
  }
}

const STATUS: Record<Check['status'], ImportRowLicenses['status']> = {
  waiting: 'waiting',
  settled: 'settled',
  timed_out: 'timedOut',
};

/** A row's license check, as the import's page shows it. */
export function rowLicenses(
  c: Pick<Check, 'status' | 'expected' | 'licenses' | 'message' | 'checked_at'>,
): ImportRowLicenses {
  const licenses =
    c.licenses ??
    c.expected.flatMap((g) =>
      g.skus.map((s) => ({ ...s, group: g.name, state: 'pending' as const, error: null })),
    );
  return {
    status: STATUS[c.status],
    message: c.status === 'settled' ? null : (c.message ?? 'Waiting for the account to sync.'),
    licenses: licenses.map((l) => ({
      ...licenseSku(l.skuId, l.skuPartNumber),
      group: l.group,
      state: l.state,
      error: l.error,
    })),
    checkedAt: c.checked_at ? new Date(c.checked_at).toISOString() : null,
  };
}

export class ImportLicenseService {
  private readonly timer: SweepTimer;
  /** Directories Graph has throttled, until when. */
  private readonly throttledUntil = new Map<number, number>();

  constructor(private readonly deps: ImportLicenseDeps) {
    this.timer = new SweepTimer(() => this.sweep(), {
      tickMs: TICK_MS,
      stopWaitMs: STOP_WAIT_MS,
      onError: (err) => deps.logger.error({ err }, 'import license checks tick failed'),
    });
  }

  start(): void {
    this.timer.start();
  }

  stop(): Promise<void> {
    return this.timer.stop();
  }

  /** Work through the due checks until none are or the tick's time is up. Returns how many were taken. */
  async sweep(budgetMs = TICK_BUDGET_MS): Promise<number> {
    const on = await this.deps.entra.directoriesWith('licenses');
    const until = Date.now() + budgetMs;
    let taken = 0;
    while (Date.now() < until && !this.timer.stopping) {
      const claimed = await this.claimDue(on);
      if (!claimed) break;
      taken++;
      await this.check(claimed.check, claimed.token);
    }
    return taken;
  }

  /** Claim the next due check whose account the import has created. */
  private async claimDue(on: readonly number[]): Promise<{ check: Check; token: string } | null> {
    if (on.length === 0) return null;
    const now = Date.now();
    const throttled = [...this.throttledUntil].flatMap(([id, at]) => (at > now ? [id] : []));
    const token = randomUUID();
    const { rows } = await sql<{ row_id: string }>`
      UPDATE import_license_checks SET claim_token = ${token}, attempts = attempts + 1,
        started_at = COALESCE(started_at, now()), next_attempt_at = ${LEASE}, updated_at = now()
      WHERE row_id = (
        SELECT c.row_id FROM import_license_checks c
        JOIN bulk_job_rows r ON r.id = c.row_id
        JOIN bulk_jobs j ON j.id = c.job_id
        WHERE c.status = 'waiting' AND c.next_attempt_at <= now()
          AND j.provider_id = ANY(${on}::int[])
          AND NOT (j.provider_id = ANY(${throttled}::int[]))
          AND r.target_id IS NOT NULL AND r.status IN ('succeeded', 'partial')
        ORDER BY c.next_attempt_at
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING row_id
    `.execute(this.deps.db);
    const rowId = rows[0]?.row_id;
    if (!rowId) return null;
    const check = await this.deps.db
      .selectFrom('import_license_checks as c')
      .innerJoin('bulk_job_rows as r', 'r.id', 'c.row_id')
      .innerJoin('bulk_jobs as j', 'j.id', 'c.job_id')
      .selectAll('c')
      .select(['r.target_id', 'r.after_json', 'j.provider_id'])
      .where('c.row_id', '=', String(rowId))
      .executeTakeFirst();
    return check ? { check, token } : null;
  }

  /** Change a check this run has claimed, letting the claim go. */
  private async update(check: Check, token: string, set: CheckUpdate): Promise<void> {
    await this.deps.db
      .updateTable('import_license_checks')
      .set({ ...set, claim_token: null, updated_at: sql`now()` })
      .where('row_id', '=', check.row_id)
      .where('claim_token', '=', token)
      .execute();
  }

  private async record(
    check: Check,
    token: string,
    outcome: CheckOutcome,
    now: Date,
    set: CheckUpdate = {},
  ): Promise<void> {
    await this.update(check, token, {
      ...set,
      status: outcome.status,
      message: outcome.status === 'settled' ? null : outcome.message,
      next_attempt_at: new Date(
        now.getTime() + (outcome.status === 'waiting' ? outcome.afterMs : 0),
      ).toISOString(),
    });
  }

  /** The account's SID, from the cache the row's run refreshed, else from AD. */
  private async sidOf(check: Check): Promise<string | null> {
    const cached = await this.deps.db
      .selectFrom('user_cache_records')
      .select('sid')
      .where('provider_id', '=', check.provider_id)
      .where('object_guid', '=', check.target_id!)
      .executeTakeFirst();
    if (cached?.sid) return cached.sid;
    const directory = await this.deps.providers.buildForDirectory(check.provider_id);
    const user = await directory.getUser({ kind: 'objectGuid', value: check.target_id! });
    return user?.sid ?? null;
  }

  /** Look once at a claimed check: find the person in Entra, then read how their licenses stand. */
  private async check(check: Check, token: string): Promise<void> {
    const now = new Date();
    const startedAt = check.started_at ? new Date(check.started_at) : now;
    const graph = await this.deps.graph.build(check.provider_id);
    if (!graph) {
      await this.update(check, token, {
        next_attempt_at: new Date(now.getTime() + retryMs(check.attempts)).toISOString(),
      });
      return;
    }
    // Only the groups the row did join can grant anything.
    const joined = new Set(
      (progressOf(check.after_json)?.groups ?? [])
        .filter((g) => g.isMember)
        .map((g) => lower(g.id)),
    );
    const expected = check.expected.filter((g) => joined.has(lower(g.groupId)));
    if (expected.length === 0) {
      const waiting = syncOutcome(startedAt, check.attempts, now);
      await this.record(
        check,
        token,
        waiting.status === 'waiting'
          ? { ...waiting, message: 'Waiting for the import to add them to their licensed groups.' }
          : {
              status: 'timed_out',
              message: 'The import didn’t add them to their licensed groups.',
            },
        now,
      );
      return;
    }
    try {
      let entraUserId = check.entra_user_id;
      if (!entraUserId) {
        const sid = await this.sidOf(check);
        entraUserId = sid ? await findEntraUser(graph, sid) : null;
      }
      if (!entraUserId) {
        await this.record(check, token, syncOutcome(startedAt, check.attempts, now), now, {
          error_code: 'unsynced',
        });
        return;
      }
      const firstSeen = !check.synced_at;
      const syncedAt = check.synced_at ? new Date(check.synced_at) : now;
      const licenses = checkedLicenses(expected, await assignmentStates(graph, entraUserId));
      // Counted from their sync, so a long wait for it doesn't slow the looks after.
      const attempts = firstSeen ? 1 : check.attempts;
      await this.record(check, token, settleOutcome(licenses, syncedAt, attempts, now), now, {
        entra_user_id: entraUserId,
        synced_at: syncedAt.toISOString(),
        licenses: JSON.stringify(licenses),
        checked_at: now.toISOString(),
        error_code: null,
        ...(firstSeen ? { attempts } : {}),
      });
    } catch (err) {
      if (err instanceof GraphPermissionError && err.statusCode === 404 && check.entra_user_id) {
        // Gone from Entra since: found again, or not, on the next look.
        await this.update(check, token, {
          entra_user_id: null,
          next_attempt_at: now.toISOString(),
        });
        return;
      }
      let afterMs = retryMs(check.attempts);
      let message = 'Something went wrong reading their licenses from Entra.';
      if (err instanceof GraphThrottledError) {
        afterMs = Math.max(30_000, err.retryAfterSeconds * 1000);
        this.throttledUntil.set(check.provider_id, Date.now() + afterMs);
        message = 'Microsoft Graph is busy: their licenses are read again shortly.';
      } else if (err instanceof GraphPermissionError) {
        message = `Couldn’t read their licenses from Entra: ${err.hint ? `${err.message} (${err.hint})` : err.message}`;
      } else if (err instanceof DirectoryUnavailableError) {
        message = 'No domain controller could be reached to find them in Entra.';
      } else {
        this.deps.logger.error({ err, rowId: check.row_id }, 'import license check failed');
      }
      await this.update(check, token, {
        error_code: 'read_failed',
        message,
        next_attempt_at: new Date(now.getTime() + afterMs).toISOString(),
      });
    }
  }
}
