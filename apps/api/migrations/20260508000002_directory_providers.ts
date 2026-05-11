// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('directory_providers', (t) => {
    t.bigIncrements('id').primary();
    t.text('name').notNullable().unique();
    t.text('type').notNullable(); // 'active-directory' | 'ldap' | 'entra'
    t.text('domain_name').notNullable();
    t.text('base_dn').notNullable();
    t.specificType('ldap_urls', 'text[]').notNullable();
    t.text('tls_mode').notNullable().defaultTo('ldaps'); // 'ldaps' | 'starttls' | 'plain'
    t.text('bind_dn_ref'); // reference to secret store / env var name; not the secret itself
    t.jsonb('config_json').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('directory_providers');
}
