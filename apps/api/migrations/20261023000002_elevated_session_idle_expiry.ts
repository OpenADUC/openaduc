// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// An elevated session now ends at whichever comes first: idle_expires_at,
// which activity pushes forward, or expires_at, its absolute lifetime.
// Sessions open at upgrade keep the fixed end they were given.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('elevated_sessions', (t) => {
    t.timestamp('idle_expires_at', { useTz: true });
  });
  await knex('elevated_sessions').update({ idle_expires_at: knex.ref('expires_at') });
  await knex.schema.alterTable('elevated_sessions', (t) => {
    t.timestamp('idle_expires_at', { useTz: true }).notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('elevated_sessions', (t) => {
    t.dropColumn('idle_expires_at');
  });
}
