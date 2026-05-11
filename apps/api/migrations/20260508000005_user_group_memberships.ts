// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_group_memberships', (t) => {
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.uuid('user_object_guid').notNullable();
    t.uuid('group_object_guid').notNullable();
    t.boolean('direct').notNullable().defaultTo(true);
    t.timestamp('synced_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['provider_id', 'user_object_guid', 'group_object_guid']);
    t.index(['provider_id', 'group_object_guid'], 'membership_by_group_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_group_memberships');
}
