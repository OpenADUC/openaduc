// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A job's reverts, found by the job they revert, and at most one of them
// not yet stopped at a time, so two operators can't revert the same job
// at once. Built concurrently, outside a transaction, so bulk_jobs keeps
// taking writes.
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS bulk_jobs_reverts_idx ON bulk_jobs (reverts_job_id) WHERE reverts_job_id IS NOT NULL',
  );
  await knex.raw(
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS bulk_jobs_one_open_revert_uq ON bulk_jobs (reverts_job_id) WHERE reverts_job_id IS NOT NULL AND status IN ('queued', 'running', 'paused')`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS bulk_jobs_one_open_revert_uq');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS bulk_jobs_reverts_idx');
}
