// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A job's reverts, found by the job they revert, and at most one of them
// not yet stopped at a time (the service also refuses one whose rows are
// still running). Built concurrently, outside a transaction, so bulk_jobs
// keeps taking writes. A concurrent build that failed leaves an INVALID
// index behind, which IF NOT EXISTS would keep: it's dropped and built
// again.
export const config = { transaction: false };

const INDEXES = {
  bulk_jobs_reverts_idx:
    'CREATE INDEX CONCURRENTLY bulk_jobs_reverts_idx ON bulk_jobs (reverts_job_id) WHERE reverts_job_id IS NOT NULL',
  bulk_jobs_one_open_revert_uq: `CREATE UNIQUE INDEX CONCURRENTLY bulk_jobs_one_open_revert_uq ON bulk_jobs (reverts_job_id) WHERE reverts_job_id IS NOT NULL AND status IN ('queued', 'running', 'paused')`,
};

export async function up(knex: Knex): Promise<void> {
  for (const [name, create] of Object.entries(INDEXES)) {
    const { rows } = await knex.raw<{ rows: { valid: boolean }[] }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ? AND pg_table_is_visible(c.oid)`,
      [name],
    );
    if (rows[0]?.valid) continue;
    if (rows[0]) await knex.raw(`DROP INDEX CONCURRENTLY ${name}`);
    await knex.raw(create);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS bulk_jobs_one_open_revert_uq');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS bulk_jobs_reverts_idx');
}
