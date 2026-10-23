// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// The audit log list filters by directory and orders by time.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('audit_events', (t) => {
    t.index(['provider_id', 'timestamp'], 'audit_provider_time_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('audit_events', (t) => {
    t.dropIndex(['provider_id', 'timestamp'], 'audit_provider_time_idx');
  });
}
