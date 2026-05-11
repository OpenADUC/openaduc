// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('elevated_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('admin_session_id')
      .notNullable()
      .references('id')
      .inTable('admin_sessions')
      .onDelete('CASCADE');
    t.text('actor_user_id').notNullable();
    t.text('auth_method').notNullable().defaultTo('ad-rebind');
    // Capabilities granted by the step-up. Typically a subset of the admin session's,
    // limited to the writes the user proved they can perform in the moment.
    t.jsonb('capabilities_json').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });

    t.index(['admin_session_id'], 'elevated_admin_idx');
    t.index(['expires_at'], 'elevated_expires_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('elevated_sessions');
}
