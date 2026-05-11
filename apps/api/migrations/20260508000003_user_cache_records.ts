// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_cache_records', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    // AD objectGUID rendered as canonical UUID string. Unique per provider.
    t.uuid('object_guid').notNullable();
    t.text('sid');
    t.text('distinguished_name').notNullable();
    t.text('sam_account_name');
    t.text('user_principal_name');
    t.text('display_name');
    t.text('given_name');
    t.text('surname');
    t.text('email');
    t.text('phone');
    t.text('mobile');
    t.text('title');
    t.text('department');
    t.text('manager_dn');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.boolean('locked').notNullable().defaultTo(false);
    t.timestamp('password_last_set_at', { useTz: true });
    t.timestamp('password_expires_at', { useTz: true });
    t.timestamp('account_expires_at', { useTz: true });
    t.timestamp('last_logon_at', { useTz: true });
    t.timestamp('created_at_source', { useTz: true });
    t.timestamp('modified_at_source', { useTz: true });
    t.timestamp('synced_at', { useTz: true });
    t.timestamp('live_refreshed_at', { useTz: true });
    t.timestamp('stale_at', { useTz: true });
    t.timestamp('deleted_at', { useTz: true });
    t.jsonb('raw_attributes_json').notNullable().defaultTo('{}');

    t.unique(['provider_id', 'object_guid']);
  });

  // Lookup indexes for the search APIs in Phase 7.
  await knex.raw(
    'CREATE INDEX user_cache_provider_sam_idx ON user_cache_records (provider_id, lower(sam_account_name))',
  );
  await knex.raw(
    'CREATE INDEX user_cache_provider_upn_idx ON user_cache_records (provider_id, lower(user_principal_name))',
  );
  await knex.raw(
    'CREATE INDEX user_cache_provider_email_idx ON user_cache_records (provider_id, lower(email))',
  );
  await knex.raw(
    'CREATE INDEX user_cache_provider_dn_idx ON user_cache_records (provider_id, distinguished_name)',
  );

  // Filter indexes (each filter on its own index — Postgres can bitmap-AND).
  await knex.schema.alterTable('user_cache_records', (t) => {
    t.index(['provider_id', 'enabled'], 'user_cache_provider_enabled_idx');
    t.index(['provider_id', 'locked'], 'user_cache_provider_locked_idx');
    t.index(['provider_id', 'password_expires_at'], 'user_cache_provider_pwexp_idx');
    t.index(['provider_id', 'account_expires_at'], 'user_cache_provider_acctexp_idx');
    t.index(['provider_id', 'last_logon_at'], 'user_cache_provider_lastlogon_idx');
    t.index(['provider_id', 'department'], 'user_cache_provider_dept_idx');
    t.index(['provider_id', 'title'], 'user_cache_provider_title_idx');
  });

  // Trigram indexes for substring search ("contains" queries) on the most-searched fields.
  await knex.raw(
    'CREATE INDEX user_cache_display_trgm_idx ON user_cache_records USING gin (display_name gin_trgm_ops)',
  );
  await knex.raw(
    'CREATE INDEX user_cache_sam_trgm_idx ON user_cache_records USING gin (sam_account_name gin_trgm_ops)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_cache_records');
}
