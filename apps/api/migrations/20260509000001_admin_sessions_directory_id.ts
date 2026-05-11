// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Multi-domain isolation: every admin session is scoped to exactly one
// directory. Switching domains = log out, log in. Reads/writes the session
// performs are filtered by this column at the route layer.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('admin_sessions', (t) => {
    t.bigInteger('directory_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.index(['directory_id', 'created_at'], 'admin_sessions_directory_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('admin_sessions', (t) => {
    t.dropIndex(['directory_id', 'created_at'], 'admin_sessions_directory_idx');
    t.dropColumn('directory_id');
  });
}
