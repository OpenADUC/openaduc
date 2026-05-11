// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Widen the schedule_kind CHECK constraint to include 'hourly'. The
// 'hourly' kind reuses interval_minutes (N*60) and anchor_at (today at
// 00:MM) so no new columns are needed — only the constraint changes.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE directory_sync_tasks
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_schedule_kind_chk,
      ADD CONSTRAINT directory_sync_tasks_schedule_kind_chk
        CHECK (schedule_kind IN ('interval', 'hourly', 'daily', 'weekly', 'monthly'));
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Revert any 'hourly' rows to 'interval' before re-tightening the
  // constraint, otherwise the ALTER will fail validation.
  await knex.raw(
    `UPDATE directory_sync_tasks SET schedule_kind = 'interval' WHERE schedule_kind = 'hourly';`,
  );
  await knex.raw(`
    ALTER TABLE directory_sync_tasks
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_schedule_kind_chk,
      ADD CONSTRAINT directory_sync_tasks_schedule_kind_chk
        CHECK (schedule_kind IN ('interval', 'daily', 'weekly', 'monthly'));
  `);
}
