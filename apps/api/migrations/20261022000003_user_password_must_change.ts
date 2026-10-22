// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // pwdLastSet = 0: the user must change their password at next logon.
  // password_expiry_computed: password_expires_at is AD's own computation
  // (null there means never), not missing. Both filled by the next sync.
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.boolean('password_must_change').notNullable().defaultTo(false);
    t.boolean('password_expiry_computed').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.dropColumn('password_must_change');
    t.dropColumn('password_expiry_computed');
  });
}
