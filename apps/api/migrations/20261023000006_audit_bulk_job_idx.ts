// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// A bulk job's audit events, found by its id. Built concurrently, outside
// a transaction, so a large audit_events table keeps taking writes.
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_bulk_job_idx ON audit_events (bulk_job_id, timestamp) WHERE bulk_job_id IS NOT NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS audit_bulk_job_idx');
}
