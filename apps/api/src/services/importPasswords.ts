// SPDX-License-Identifier: BUSL-1.1
// The passwords an import hands out in its results CSV (generate and set
// modes), held encrypted with the app's secret key until the operator
// downloads the CSV, once, or IMPORT_PASSWORDS_HELD_HOURS pass. They're
// never in the job's rows or its audit events.
import { IMPORT_PASSWORDS_HELD_HOURS } from '@openaduc/shared';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../lib/encryption.js';

const HELD_UNTIL = (createdAt: Date) =>
  new Date(createdAt.getTime() + IMPORT_PASSWORDS_HELD_HOURS * 60 * 60 * 1000);

/** Whether the job's passwords may still be held: not downloaded, not expired. */
export function passwordsHoldable(job: {
  created_at: Date;
  results_downloaded_at: Date | null;
}): boolean {
  return job.results_downloaded_at === null && HELD_UNTIL(job.created_at) > new Date();
}

export const passwordsExpireAt = HELD_UNTIL;

/**
 * Hold a password for one row of the job, or with no row for every row
 * (set mode), replacing any held before.
 */
export async function holdPassword(
  db: Kysely<DB>,
  job: { id: string; created_at: Date },
  rowId: string | null,
  password: string,
): Promise<void> {
  const values = {
    job_id: job.id,
    row_id: rowId,
    password_enc: encryptSecret(password),
    expires_at: HELD_UNTIL(job.created_at),
  };
  await db
    .insertInto('import_passwords')
    .values(values)
    .onConflict((oc) =>
      rowId === null
        ? oc
            .column('job_id')
            .where('row_id', 'is', null)
            .doUpdateSet({ password_enc: values.password_enc })
        : oc
            .column('row_id')
            .where('row_id', 'is not', null)
            .doUpdateSet({ password_enc: values.password_enc }),
    )
    .execute();
}

/** The password held for the row, else the job's one for every row, while unexpired. */
export async function heldPassword(
  db: Kysely<DB>,
  jobId: string,
  rowId: string,
): Promise<string | null> {
  const held = await db
    .selectFrom('import_passwords')
    .select(['row_id', 'password_enc'])
    .where('job_id', '=', jobId)
    .where((eb) => eb.or([eb('row_id', '=', rowId), eb('row_id', 'is', null)]))
    .where('expires_at', '>', sql<Date>`now()`)
    .execute();
  const own = held.find((h) => h.row_id !== null) ?? held[0];
  return own ? decryptSecret(own.password_enc) : null;
}

/**
 * Take the job's passwords, by row id ('' for every row's), deleting them
 * and marking the results downloaded, in one transaction: a second
 * download, or a concurrent one, finds none. Null when they were taken
 * already or the job's results can't be downloaded any more.
 */
export async function takePasswords(
  db: Kysely<DB>,
  jobId: string,
): Promise<Map<string, string> | null> {
  return db.transaction().execute(async (trx) => {
    const marked = await trx
      .updateTable('bulk_jobs')
      .set({ results_downloaded_at: sql`now()` })
      .where('id', '=', jobId)
      .where('results_downloaded_at', 'is', null)
      .executeTakeFirst();
    if (Number(marked.numUpdatedRows) === 0) return null;
    const held = await trx
      .deleteFrom('import_passwords')
      .where('job_id', '=', jobId)
      .returning(['row_id', 'password_enc', 'expires_at'])
      .execute();
    const now = Date.now();
    return new Map(
      held
        .filter((h) => new Date(h.expires_at).getTime() > now)
        .map((h) => [h.row_id ?? '', decryptSecret(h.password_enc)]),
    );
  });
}

/** Delete the passwords held past their time. Returns how many went. */
export async function purgeExpiredPasswords(db: Kysely<DB>): Promise<number> {
  const purged = await db
    .deleteFrom('import_passwords')
    .where('expires_at', '<=', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(purged.numDeletedRows);
}
