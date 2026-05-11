// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

const DEFAULTS: Array<{ key: string; value: unknown; description: string }> = [
  {
    key: 'audit.retention_days',
    value: 365,
    description: 'How long audit_events are retained before cleanup. -1 = forever.',
  },
  {
    key: 'audit.account_view_enabled',
    value: true,
    description: 'Whether opening a user detail page produces an audit event.',
  },
  {
    key: 'audit.search_enabled',
    value: false,
    description:
      'Whether each user/group search produces an audit event. High-volume; off by default.',
  },
  {
    key: 'session.idle_timeout_minutes',
    value: 60,
    description: 'Idle timeout before an admin session is considered expired.',
  },
  {
    key: 'session.absolute_timeout_hours',
    value: 12,
    description: 'Absolute lifetime of an admin session regardless of activity.',
  },
  {
    key: 'stepup.ttl_minutes',
    value: 60,
    description: 'How long an elevated session lasts after step-up.',
  },
  {
    key: 'authz.admin_group_dn',
    value: null,
    description:
      'AD group DN whose members get the admin role. Falls back to BOOTSTRAP_ADMIN_GROUP_DN env var until configured.',
  },
  {
    key: 'authz.operator_group_dn',
    value: null,
    description: 'AD group DN whose members get the operator role.',
  },
  {
    key: 'authz.auditor_group_dn',
    value: null,
    description: 'AD group DN whose members get the auditor role.',
  },
  {
    key: 'sync.cron',
    value: '0 2 * * *',
    description: 'Cron schedule for nightly directory sync. Set to null to disable.',
  },
  {
    key: 'sync.stale_grace_hours',
    value: 48,
    description:
      'How long a record can be missing from sync before being marked stale_at; deleted_at follows after stale_after_days.',
  },
  {
    key: 'sync.deleted_after_days',
    value: 14,
    description: 'How many additional days to wait after stale_at before marking deleted_at.',
  },
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_settings', (t) => {
    t.text('key').primary();
    t.jsonb('value_json'); // nullable: a setting can intentionally be unset
    t.text('description');
    t.text('updated_by_actor_id');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Seed defaults. Use ON CONFLICT to make the migration idempotent if re-run after partial failure.
  for (const row of DEFAULTS) {
    await knex.raw(
      `INSERT INTO app_settings (key, value_json, description) VALUES (?, ?::jsonb, ?)
       ON CONFLICT (key) DO NOTHING`,
      [row.key, JSON.stringify(row.value), row.description],
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_settings');
}
