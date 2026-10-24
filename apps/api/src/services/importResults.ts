// SPDX-License-Identifier: BUSL-1.1
// An import's results: each row as the job left it, whether its CSV still
// holds the passwords, and the CSV itself.
import {
  csvRow,
  type ImportJobRow,
  type ImportPasswordsState,
  type ImportResultsDownload,
} from '@openaduc/shared';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { progressOf } from './bulkJobs/importRows.js';
import type { JobRecord } from './bulkJobs/service.js';
import { passwordsExpireAt, passwordsHoldable } from './importPasswords.js';

const STATUS_LABEL: Record<ImportJobRow['status'], string> = {
  pending: 'Not run',
  running: 'Running',
  succeeded: 'Created',
  partial: 'Created, with problems',
  failed: 'Not created',
  skipped: 'Skipped',
};

/** The job's rows as its operator reads them, in spreadsheet order, with their ids for the CSV. */
export async function importJobRows(
  db: Kysely<DB>,
  jobId: string,
): Promise<(ImportJobRow & { rowId: string })[]> {
  const rows = await db
    .selectFrom('bulk_job_rows')
    .select(['id', 'target_id', 'status', 'error_message', 'input_json', 'after_json'])
    .where('job_id', '=', jobId)
    .orderBy('ordinal')
    .execute();
  return rows
    .map((r) => {
      const input = r.input_json ?? {};
      const progress = progressOf(r.after_json);
      return {
        rowId: String(r.id),
        line: Number(input['line']),
        displayName: String(input['displayName']),
        samAccountName: String(input['samAccountName']),
        userPrincipalName: String(input['userPrincipalName']),
        status: r.status,
        id: r.target_id,
        completed: progress?.completed ?? [],
        failed: progress?.failed ?? [],
        errorMessage: r.error_message,
      };
    })
    .sort((a, b) => a.line - b.line);
}

/** Whether the job's results CSV holds passwords, and whether it still can. */
export function passwordsState(
  job: Pick<JobRecord, 'subject_json' | 'created_at' | 'results_downloaded_at'>,
): ImportPasswordsState {
  const mode = job.subject_json?.import?.passwordMode ?? 'random';
  if (mode === 'random') return 'none';
  if (job.results_downloaded_at) return 'downloaded';
  return passwordsHoldable(job) ? 'held' : 'expired';
}

export function resultsSummary(
  job: Pick<JobRecord, 'subject_json' | 'created_at' | 'results_downloaded_at'>,
) {
  const passwords = passwordsState(job);
  return {
    passwords,
    downloadedAt: job.results_downloaded_at
      ? new Date(job.results_downloaded_at).toISOString()
      : null,
    expiresAt:
      passwords === 'none' ? null : passwordsExpireAt(new Date(job.created_at)).toISOString(),
  };
}

/**
 * The results CSV: a line per row. With `passwords` (by row id, '' for
 * the one every row got), a row whose password was set has it, and
 * whether they must change it at sign-in.
 */
export function resultsCsv(
  job: Pick<JobRecord, 'id' | 'created_at' | 'subject_json'>,
  rows: readonly (ImportJobRow & { rowId: string })[],
  passwords: ReadonlyMap<string, string> | null,
): ImportResultsDownload {
  const mustChange = job.subject_json?.import?.mustChange ?? false;
  const header = [
    'Row',
    'Status',
    'Display name',
    'Username',
    'UPN',
    ...(passwords ? ['Password', 'Must change password'] : []),
    'Problems',
  ];
  const lines = rows.map((r) => {
    const password = r.completed.includes('password')
      ? (passwords?.get(r.rowId) ?? passwords?.get('') ?? '')
      : '';
    return csvRow([
      r.line,
      STATUS_LABEL[r.status],
      r.displayName,
      r.samAccountName,
      r.userPrincipalName,
      ...(passwords ? [password, password ? (mustChange ? 'Yes' : 'No') : ''] : []),
      r.errorMessage ?? '',
    ]);
  });
  const day = new Date(job.created_at).toISOString().slice(0, 10);
  return {
    fileName: `import-${String(job.id)}-${day}.csv`,
    csv: [csvRow(header), ...lines].join('\r\n') + '\r\n',
  };
}
