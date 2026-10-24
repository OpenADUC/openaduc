// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// The audit log list filters by directory and orders by time. Built
// concurrently, outside a transaction, so a large audit_events table on a
// live install keeps taking writes while it builds.
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_provider_time_idx ON audit_events (provider_id, timestamp)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS audit_provider_time_idx');
}
