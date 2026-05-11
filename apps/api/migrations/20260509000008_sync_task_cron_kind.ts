// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Adds the 'cron' schedule kind for power users who want full cron
// expressions instead of the canned Minutes/Hourly/Daily/Weekly/Monthly
// pickers. The expression itself lives in `cron_expr` and is validated
// by cron-parser at the route boundary.
//
// 'cron' rows ignore interval_minutes / anchor_at / monthly_day — only
// cron_expr matters. The CHECK constraint enforces that cron_expr is
// only set when schedule_kind = 'cron' so the row shape stays
// trustworthy.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('directory_sync_tasks', (t) => {
    t.text('cron_expr');
  });
  await knex.raw(`
    ALTER TABLE directory_sync_tasks
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_schedule_kind_chk,
      ADD CONSTRAINT directory_sync_tasks_schedule_kind_chk
        CHECK (schedule_kind IN ('interval', 'hourly', 'daily', 'weekly', 'monthly', 'cron')),
      ADD CONSTRAINT directory_sync_tasks_cron_expr_only_when_cron_chk
        CHECK (schedule_kind = 'cron' OR cron_expr IS NULL);
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Demote any 'cron' rows back to 'interval' so the tightened
  // constraint will accept them.
  await knex.raw(`
    UPDATE directory_sync_tasks
    SET schedule_kind = 'interval', cron_expr = NULL
    WHERE schedule_kind = 'cron';
  `);
  await knex.raw(`
    ALTER TABLE directory_sync_tasks
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_cron_expr_only_when_cron_chk,
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_schedule_kind_chk,
      ADD CONSTRAINT directory_sync_tasks_schedule_kind_chk
        CHECK (schedule_kind IN ('interval', 'hourly', 'daily', 'weekly', 'monthly'));
  `);
  await knex.schema.alterTable('directory_sync_tasks', (t) => {
    t.dropColumn('cron_expr');
  });
}
