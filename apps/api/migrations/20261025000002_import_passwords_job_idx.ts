// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A job's held passwords, found by the job: its results page and download
// read them, and a reset job's rows hold theirs by job. Built concurrently,
// outside a transaction, so import_passwords keeps taking writes. A
// concurrent build that failed leaves an INVALID index behind, which IF
// NOT EXISTS would keep: it's dropped and built again.
export const config = { transaction: false };

const NAME = 'import_passwords_job_idx';

export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{ rows: { valid: boolean }[] }>(
    `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ? AND pg_table_is_visible(c.oid)`,
    [NAME],
  );
  if (rows[0]?.valid) return;
  if (rows[0]) await knex.raw(`DROP INDEX CONCURRENTLY ${NAME}`);
  await knex.raw(`CREATE INDEX CONCURRENTLY ${NAME} ON import_passwords (job_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${NAME}`);
}
