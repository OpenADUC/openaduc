// SPDX-License-Identifier: BUSL-1.1
// The results of a job that hands out passwords (an import, a password
// reset of an import's accounts): each row as the job left it, whether
// its CSV still holds the passwords, and the CSV itself, which with
// passwords can be downloaded once, by its operator, once the job has
// stopped, while they're held.
import {
  IMPORT_JOB_ACTION,
  IMPORT_ROW_STATUS_LABEL,
  LICENSE_ERROR_TEXT,
  bulkJobStopped,
  csvRow,
  type BulkJob,
  type BulkJobResultsDownload,
  type BulkJobRowStatus,
  type HeldPasswords,
  type ImportJobResponse,
  type ImportJobRow,
  type ImportRowLicenses,
} from '@openaduc/shared';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { AuditEventInput, AuditService } from './audit.js';
import { progressOf } from './bulkJobs/importRows.js';
import { BulkJobRequestError } from './bulkJobs/errors.js';
import type { JobRecord } from './bulkJobs/service.js';
import { heldFor, takePasswords, type TakenPasswords } from './heldPasswords.js';
import { rowLicenses } from './importLicenses/service.js';

export const PASSWORD_RESET_ACTION = 'user.password.reset';

type Job = Pick<
  JobRecord,
  'id' | 'action' | 'subject_json' | 'created_at' | 'results_downloaded_at' | 'provider_id'
>;

/** Whether the job hands out passwords: a reset does; an import unless in random mode. */
export function handsOutPasswords(job: Pick<Job, 'action' | 'subject_json'>): boolean {
  if (job.action === PASSWORD_RESET_ACTION) return true;
  return job.action === IMPORT_JOB_ACTION && job.subject_json?.import?.passwordMode !== 'random';
}

type ResultRow = { rowId: string; status: BulkJobRowStatus; passwordSet: boolean };

/**
 * Whether the job's CSV holds passwords now. `rows` say which rows were
 * given one: a stopped job holding none had them purged unseen, unless no
 * row was given one at all.
 */
async function summary(
  db: Kysely<DB>,
  job: Job,
  described: BulkJob,
  rows: readonly ResultRow[],
): Promise<{ results: HeldPasswords; held: Awaited<ReturnType<typeof heldFor>> | null }> {
  const downloadedAt = job.results_downloaded_at
    ? new Date(job.results_downloaded_at).toISOString()
    : null;
  if (!handsOutPasswords(job)) {
    return { results: { passwords: 'none', downloadedAt, expiresAt: null }, held: null };
  }
  if (downloadedAt)
    return { results: { passwords: 'downloaded', downloadedAt, expiresAt: null }, held: null };
  const held = await heldFor(db, String(job.id));
  const holding = held.rows.size > 0 || held.shared;
  const passwords =
    holding || !bulkJobStopped(described)
      ? 'held'
      : rows.some((r) => r.passwordSet)
        ? 'expired'
        : 'none';
  return {
    results: { passwords, downloadedAt, expiresAt: held.firstExpiry?.toISOString() ?? null },
    held,
  };
}

const passwordHeld = (held: Awaited<ReturnType<typeof heldFor>> | null, rowId: string) =>
  !!held && (held.shared || held.rows.has(rowId));

/** An import's rows as its operator reads them, in spreadsheet order, with their ids for the CSV. */
async function importRows(db: Kysely<DB>, jobId: string) {
  const rows = await db
    .selectFrom('bulk_job_rows as r')
    .leftJoin('import_license_checks as c', 'c.row_id', 'r.id')
    .select([
      'r.id',
      'r.target_id',
      'r.status',
      'r.error_message',
      'r.input_json',
      'r.after_json',
      'c.status as license_status',
      'c.expected as license_expected',
      'c.licenses',
      'c.message as license_message',
      'c.checked_at as license_checked_at',
    ])
    .where('r.job_id', '=', jobId)
    .orderBy('r.ordinal')
    .execute();
  return rows
    .map((r) => {
      const input = r.input_json ?? {};
      const progress = progressOf(r.after_json);
      const completed = progress?.completed ?? [];
      return {
        rowId: String(r.id),
        passwordSet: completed.includes('password'),
        fallback: progress?.passwordFallback === 'random',
        line: Number(input['line']),
        displayName: String(input['displayName']),
        samAccountName: String(input['samAccountName']),
        userPrincipalName: String(input['userPrincipalName']),
        status: r.status,
        id: r.target_id,
        completed,
        failed: progress?.failed ?? [],
        errorMessage: r.error_message,
        licenses:
          r.license_status && r.license_expected && r.target_id
            ? rowLicenses({
                status: r.license_status,
                expected: r.license_expected,
                licenses: r.licenses,
                message: r.license_message,
                checked_at: r.license_checked_at,
              })
            : null,
      };
    })
    .sort((a, b) => a.line - b.line);
}

type ImportRows = Awaited<ReturnType<typeof importRows>>;

/**
 * Nobody can know a row's password: it fell back to a random one, or the
 * job hands passwords out and this one was purged unseen.
 */
function needsReset(
  row: ImportRows[number],
  results: HeldPasswords,
  held: Awaited<ReturnType<typeof heldFor>> | null,
): boolean {
  if (row.fallback) return true;
  if (!row.passwordSet) return false;
  if (results.passwords === 'expired') return true;
  return results.passwords === 'held' && !!held && !passwordHeld(held, row.rowId);
}

/** An import's results page: its rows, its CSV's state, and its latest password reset. */
export async function importJobView(
  db: Kysely<DB>,
  describe: (id: string) => Promise<BulkJob>,
  job: JobRecord,
): Promise<Omit<ImportJobResponse, 'classTap'>> {
  const described = await describe(String(job.id));
  const rows = await importRows(db, String(job.id));
  const { results, held } = await summary(db, job, described, rows);
  const reset = await db
    .selectFrom('bulk_jobs')
    .selectAll()
    .where('provider_id', '=', job.provider_id)
    .where('actor_user_id', '=', job.actor_user_id)
    .where('action', '=', PASSWORD_RESET_ACTION)
    .where(sql<string>`subject_json->>'importJobId'`, '=', String(job.id))
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  let passwordReset: ImportJobResponse['passwordReset'] = null;
  if (reset) {
    const resetJob = await describe(String(reset.id));
    const resetRows = await resetResultRows(db, reset);
    passwordReset = {
      job: resetJob,
      results: (await summary(db, reset, resetJob, resetRows)).results,
    };
  }
  return {
    job: described,
    rows: rows.map((r): ImportJobRow => ({
      line: r.line,
      displayName: r.displayName,
      samAccountName: r.samAccountName,
      userPrincipalName: r.userPrincipalName,
      status: r.status,
      id: r.id,
      completed: r.completed,
      failed: r.failed,
      errorMessage: r.errorMessage,
      needsPasswordReset: needsReset(r, results, held),
      licenses: r.licenses,
    })),
    results,
    passwordReset,
  };
}

const RESET_STATUS_LABEL: Record<BulkJobRowStatus, string> = {
  pending: 'Waiting',
  running: 'Resetting',
  succeeded: 'Reset',
  partial: 'Reset',
  failed: 'Not reset',
  skipped: 'Skipped',
};

/** A reset job's rows, named from the cache. */
async function resetResultRows(db: Kysely<DB>, job: Job) {
  const rows = await db
    .selectFrom('bulk_job_rows as r')
    .leftJoin('user_cache_records as u', (j) =>
      j
        .on((eb) => eb(sql<string>`u.object_guid::text`, '=', eb.ref('r.target_id')))
        .on('u.provider_id', '=', job.provider_id),
    )
    .select([
      'r.id',
      'r.status',
      'r.error_message',
      'r.target_name',
      'u.display_name',
      'u.sam_account_name',
      'u.user_principal_name',
    ])
    .where('r.job_id', '=', job.id)
    .orderBy('r.ordinal')
    .execute();
  return rows.map((r) => ({
    rowId: String(r.id),
    status: r.status,
    passwordSet: r.status === 'succeeded',
    displayName: r.display_name ?? r.target_name ?? '',
    samAccountName: r.sam_account_name ?? '',
    userPrincipalName: r.user_principal_name ?? '',
    errorMessage: r.error_message,
  }));
}

const LICENSE_STATE_TEXT: Record<ImportRowLicenses['licenses'][number]['state'], string> = {
  pending: 'not assigned yet',
  active: 'assigned',
  activeWithError: 'assigned, with an error',
  disabled: 'disabled',
  error: 'not assigned',
};

/** What the CSV says of a row's licenses: each one's state and error, and what it waits for. */
function licensesCell(l: ImportRowLicenses): string {
  const each = l.licenses.map((x) =>
    x.error || x.state === 'error'
      ? `${x.name}: ${LICENSE_ERROR_TEXT[x.error ?? 'Other']}`
      : `${x.name}: ${LICENSE_STATE_TEXT[x.state]}`,
  );
  return [...each, l.message].filter(Boolean).join(' ');
}

function passwordOf(taken: TakenPasswords | null, row: ResultRow): string {
  if (!taken || !row.passwordSet) return '';
  return taken.byRow.get(row.rowId) ?? taken.shared ?? '';
}

/**
 * The results CSV: a line per row. With `taken` passwords, a row whose
 * password was set has it, written exactly (never neutralised: none
 * starts like a formula), and whether they must change it at sign-in.
 */
async function resultsCsv(
  db: Kysely<DB>,
  job: Job,
  taken: TakenPasswords | null,
): Promise<BulkJobResultsDownload> {
  const withPasswords = taken !== null;
  const reset = job.action === PASSWORD_RESET_ACTION;
  const mustChange = reset || (job.subject_json?.import?.mustChange ?? false);
  const rows = reset ? null : await importRows(db, String(job.id));
  const withLicenses = !!rows?.some((r) => r.licenses);
  const header = [
    ...(reset ? [] : ['Row']),
    'Status',
    'Display name',
    'Username',
    'UPN',
    ...(withPasswords ? ['Password', 'Must change password'] : []),
    'Problems',
    ...(withLicenses ? ['Licenses'] : []),
  ];
  const passwordCells = (row: ResultRow) => {
    if (!withPasswords) return [];
    const password = passwordOf(taken, row);
    return password ? [{ exact: password }, mustChange ? 'Yes' : 'No'] : ['', ''];
  };
  const lines = reset
    ? (await resetResultRows(db, job)).map((r) =>
        csvRow([
          RESET_STATUS_LABEL[r.status],
          r.displayName,
          r.samAccountName,
          r.userPrincipalName,
          ...passwordCells(r),
          r.errorMessage ?? '',
        ]),
      )
    : rows!.map((r) =>
        csvRow([
          r.line,
          IMPORT_ROW_STATUS_LABEL[r.status],
          r.displayName,
          r.samAccountName,
          r.userPrincipalName,
          ...passwordCells(r),
          [r.errorMessage, r.fallback ? 'Its password is random: reset it.' : null]
            .filter(Boolean)
            .join(' '),
          ...(withLicenses ? [r.licenses ? licensesCell(r.licenses) : ''] : []),
        ]),
      );
  const day = new Date(job.created_at).toISOString().slice(0, 10);
  return {
    fileName: `${reset ? 'password-reset' : 'import'}-${String(job.id)}-${day}.csv`,
    csv: [csvRow(header), ...lines].join('\r\n') + '\r\n',
  };
}

/**
 * Download the job's results CSV, as its operator. Refused while the job
 * runs, and in a job that hands out passwords once they've been
 * downloaded or purged; a refusal is audited as one. Taking the passwords
 * and auditing the download happen in one transaction, so neither happens
 * without the other.
 */
export async function downloadResults(
  deps: { db: Kysely<DB>; audit: Pick<AuditService, 'recordEvent'> },
  job: JobRecord,
  described: BulkJob,
  audit: Omit<AuditEventInput, 'action' | 'result'>,
): Promise<BulkJobResultsDownload> {
  const event = (result: 'success' | 'failure', more: Partial<AuditEventInput> = {}) => ({
    ...audit,
    action: 'bulk.results.download',
    result,
    actorAuthMethod: 'ad-password' as const,
    providerId: job.provider_id,
    targetType: 'user' as const,
    bulkJobId: String(job.id),
    ...more,
  });
  const refuse = async (err: BulkJobRequestError): Promise<never> => {
    await deps.audit.recordEvent(event('failure', { errorCode: err.code }));
    throw err;
  };

  if (!bulkJobStopped(described)) {
    return refuse(
      new BulkJobRequestError(
        'job_running',
        'The job hasn’t stopped. Let it finish, or stop it, then download its results.',
      ),
    );
  }
  const rows =
    job.action === PASSWORD_RESET_ACTION
      ? await resetResultRows(deps.db, job)
      : await importRows(deps.db, String(job.id));
  const { results } = await summary(deps.db, job, described, rows);
  if (results.passwords === 'downloaded') {
    return refuse(
      new BulkJobRequestError(
        'results_downloaded',
        'The results, with their passwords, have been downloaded already. Reset the passwords of anyone who didn’t get theirs.',
      ),
    );
  }
  if (results.passwords === 'expired') {
    return refuse(
      new BulkJobRequestError(
        'passwords_expired',
        'The passwords were purged, unseen. Reset the accounts’ passwords.',
      ),
    );
  }
  if (results.passwords === 'none') {
    await deps.audit.recordEvent(
      event('success', { metadata: { rows: rows.length, passwords: false } }),
    );
    return resultsCsv(deps.db, job, null);
  }
  const taken = await deps.db.transaction().execute(async (trx) => {
    const got = await takePasswords(trx, String(job.id));
    if (got) {
      await deps.audit.recordEvent(
        event('success', { metadata: { rows: rows.length, passwords: true } }),
        trx,
      );
    }
    return got;
  });
  if (!taken) {
    return refuse(
      new BulkJobRequestError(
        'results_downloaded',
        'The results, with their passwords, have been downloaded already.',
      ),
    );
  }
  return resultsCsv(deps.db, job, taken);
}
