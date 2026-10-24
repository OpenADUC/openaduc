// SPDX-License-Identifier: BUSL-1.1
// The passwords a bulk job hands out in its results CSV (an import in
// generate or set mode, a password reset), held encrypted with the app's
// secret key until the operator downloads the CSV, once, or
// HELD_PASSWORD_HOURS pass from when each was stored or the job last
// finished. Each ciphertext is bound to its job and row, so it can't be
// moved to another. They're never in the job's rows or its audit events.
import { HELD_PASSWORD_HOURS, generatePassword, startsLikeFormula } from '@openaduc/shared';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../lib/encryption.js';
import type { DirectoryProvider } from '../providers/types.js';

const HELD_FOR = sql<Date>`now() + make_interval(hours => ${HELD_PASSWORD_HOURS})`;

const bindingOf = (jobId: string, rowId: string | null) =>
  `import_passwords:${jobId}:${rowId ?? 'shared'}`;

/**
 * A password to hand out: the domain's policy met, and never starting
 * like a formula, so the results CSV holds it exactly.
 */
export async function handedOutPassword(
  provider: DirectoryProvider,
  account: { samAccountName: string | null; displayName: string | null },
): Promise<string> {
  const policy = await provider.getDomainPolicy().catch(() => null);
  let password: string;
  do password = generatePassword(policy, account);
  while (startsLikeFormula(password));
  return password;
}

/** Whether the job may still hold passwords: its results haven't been downloaded. */
export const passwordsHoldable = (job: { results_downloaded_at: Date | null }): boolean =>
  job.results_downloaded_at === null;

/**
 * Hold a password for one row of the job, or with no row the one every
 * row gets (an import's set mode), replacing any held before.
 */
export async function holdPassword(
  db: Kysely<DB>,
  jobId: string,
  rowId: string | null,
  password: string,
): Promise<void> {
  const password_enc = encryptSecret(password, bindingOf(jobId, rowId));
  await db
    .insertInto('import_passwords')
    .values({ job_id: jobId, row_id: rowId, password_enc, expires_at: HELD_FOR })
    .onConflict((oc) =>
      (rowId === null
        ? oc.column('job_id').where('row_id', 'is', null)
        : oc.column('row_id').where('row_id', 'is not', null)
      ).doUpdateSet({ password_enc, expires_at: HELD_FOR }),
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
  return own ? decryptSecret(own.password_enc, bindingOf(jobId, own.row_id)) : null;
}

/** What the job holds now: which rows have their own, whether there's a shared one, and when the first goes. */
export async function heldFor(
  db: Kysely<DB>,
  jobId: string,
): Promise<{ rows: Set<string>; shared: boolean; firstExpiry: Date | null }> {
  const held = await db
    .selectFrom('import_passwords')
    .select(['row_id', 'expires_at'])
    .where('job_id', '=', jobId)
    .where('expires_at', '>', sql<Date>`now()`)
    .execute();
  const expiries = held.map((h) => new Date(h.expires_at).getTime());
  return {
    rows: new Set(held.flatMap((h) => (h.row_id === null ? [] : [String(h.row_id)]))),
    shared: held.some((h) => h.row_id === null),
    firstExpiry: expiries.length ? new Date(Math.min(...expiries)) : null,
  };
}

/** Hold the job's passwords HELD_PASSWORD_HOURS from now: it has just finished. */
export async function holdFromNow(db: Kysely<DB>, jobId: string): Promise<void> {
  await db
    .updateTable('import_passwords')
    .set({ expires_at: HELD_FOR })
    .where('job_id', '=', jobId)
    .where('expires_at', '>', sql<Date>`now()`)
    .execute();
}

export interface TakenPasswords {
  /** The one every row got (an import's set mode). */
  shared: string | null;
  byRow: Map<string, string>;
}

/**
 * Take the job's passwords, in `trx`: marking its results downloaded and
 * deleting them, so a second download, or a concurrent one, finds none.
 * Null when they were taken already.
 */
export async function takePasswords(
  trx: Kysely<DB>,
  jobId: string,
): Promise<TakenPasswords | null> {
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
  const taken: TakenPasswords = { shared: null, byRow: new Map() };
  const now = Date.now();
  for (const h of held) {
    if (new Date(h.expires_at).getTime() <= now) continue;
    const rowId = h.row_id === null ? null : String(h.row_id);
    const password = decryptSecret(h.password_enc, bindingOf(jobId, rowId));
    if (rowId === null) taken.shared = password;
    else taken.byRow.set(rowId, password);
  }
  return taken;
}

/** Delete the passwords held past their time. Returns how many went. */
export async function purgeExpiredPasswords(db: Kysely<DB>): Promise<number> {
  const purged = await db
    .deleteFrom('import_passwords')
    .where('expires_at', '<=', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(purged.numDeletedRows);
}
