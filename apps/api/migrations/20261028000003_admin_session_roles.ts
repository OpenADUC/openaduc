// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Sessions keep the roles AD group membership gave at sign-in instead of the
// capabilities those roles had then, which went stale whenever a release
// added capabilities. Open sessions get the roles their snapshot implies, so
// nobody is signed out: configure:security is only the admin's,
// write:user.unlock only the admin's and operator's, view:audit only the
// admin's and auditor's. A snapshot matching none resolves to no session.
// Literals, not @openaduc/shared's constants: a migration must keep doing
// what it did when it shipped.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('admin_sessions', (t) => {
    t.jsonb('roles_json').notNullable().defaultTo('[]');
  });
  await knex.raw(`
    UPDATE admin_sessions SET roles_json =
      CASE WHEN capabilities_json @> '["configure:security"]' THEN '["admin"]'::jsonb
      ELSE
        CASE WHEN capabilities_json @> '["write:user.unlock"]' THEN '["operator"]'::jsonb
             ELSE '[]'::jsonb END
        || CASE WHEN capabilities_json @> '["view:audit"]' THEN '["auditor"]'::jsonb
                ELSE '[]'::jsonb END
      END
     WHERE revoked_at IS NULL AND expires_at > now()
  `);
  await knex.schema.alterTable('admin_sessions', (t) => {
    t.dropColumn('capabilities_json');
  });
}

// Rolling back can't rebuild a snapshot from roles without the role
// definitions of the build it rolls back to, so open sessions end instead.
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('admin_sessions', (t) => {
    t.jsonb('capabilities_json').notNullable().defaultTo('[]');
  });
  await knex('admin_sessions').whereNull('revoked_at').update({ revoked_at: knex.fn.now() });
  await knex.schema.alterTable('admin_sessions', (t) => {
    t.dropColumn('roles_json');
  });
}
