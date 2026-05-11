// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_events', (t) => {
    t.bigIncrements('id').primary();
    t.timestamp('timestamp', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Actor identity. Plain text — these are denormalized snapshots, not FKs.
    t.text('actor_user_id'); // typically AD objectGUID as canonical UUID string
    t.text('actor_display_name');
    t.text('actor_auth_method'); // 'ad-password' | 'sso' | 'system'

    // Request metadata.
    t.text('source_ip');
    t.text('user_agent');
    t.text('session_id');
    t.text('correlation_id');

    // Provider + target.
    t.bigInteger('provider_id')
      .references('id')
      .inTable('directory_providers')
      .onDelete('SET NULL');
    t.text('target_type'); // 'user' | 'group' | 'session' | 'config' | 'system'
    t.text('target_id'); // objectGUID, app id, etc.
    t.text('target_dn');

    // Action + outcome.
    t.text('action').notNullable();
    t.text('result').notNullable(); // 'success' | 'failure' | 'denied'
    t.text('error_code');

    // Payload.
    t.jsonb('before_json');
    t.jsonb('after_json');
    t.jsonb('metadata_json').notNullable().defaultTo('{}');
  });

  // Query indexes — most audit reads filter by time + actor or time + target.
  await knex.schema.alterTable('audit_events', (t) => {
    t.index(['timestamp'], 'audit_timestamp_idx');
    t.index(['actor_user_id', 'timestamp'], 'audit_actor_time_idx');
    t.index(['target_type', 'target_id', 'timestamp'], 'audit_target_time_idx');
    t.index(['action', 'timestamp'], 'audit_action_time_idx');
    t.index(['correlation_id'], 'audit_correlation_idx');
    t.index(['result', 'timestamp'], 'audit_result_time_idx');
  });

  // Append-only enforcement at the DB level. Defends against bugs in app code
  // that might try to UPDATE/DELETE — failure cases above the app layer require
  // a superuser, which the application's runtime role should never be.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION audit_events_block_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only (op: %)', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$;
  `);

  await knex.raw(`
    CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();
  `);

  await knex.raw(`
    CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();
  `);

  // TRUNCATE is statement-level, so it needs its own trigger.
  await knex.raw(`
    CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_mutation();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events');
  await knex.raw('DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events');
  await knex.raw('DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events');
  await knex.raw('DROP FUNCTION IF EXISTS audit_events_block_mutation()');
  await knex.schema.dropTableIfExists('audit_events');
}
