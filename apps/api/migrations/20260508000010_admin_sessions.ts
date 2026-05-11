// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('admin_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // sha256 of the random session token. Raw token only ever lives in the cookie.
    t.text('token_hash').notNullable().unique();
    t.text('actor_user_id').notNullable(); // AD objectGUID as canonical UUID string
    t.text('actor_display_name');
    t.text('actor_username');
    t.text('actor_email');
    t.text('actor_dn');
    // Snapshot of capabilities at login time. Refreshed by re-login or explicit refresh.
    t.jsonb('capabilities_json').notNullable().defaultTo('[]');
    t.text('source_ip');
    t.text('user_agent');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });

    t.index(['actor_user_id', 'created_at'], 'admin_sessions_actor_idx');
    t.index(['expires_at'], 'admin_sessions_expires_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('admin_sessions');
}
