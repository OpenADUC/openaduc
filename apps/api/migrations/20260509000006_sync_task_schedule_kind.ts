// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Adds named schedule kinds to directory_sync_tasks. The pre-existing
// `interval_minutes` + `anchor_at` covers "every N minutes" cleanly but
// can't express "monthly on the 15th" because months aren't fixed-length.
//
// schedule_kind = 'interval' (default) preserves the previous behaviour
// for every existing row. The other three kinds layer on:
//
//   'daily'    — anchor_at HH:MM (extracted), runs once per day
//   'weekly'   — anchor_at day-of-week + HH:MM, runs once per week
//   'monthly'  — anchor_at HH:MM + monthly_day ('1'..'28' or 'last'),
//                runs once per month
//
// monthly_day uses the literal text 'last' rather than the magic value
// 31 so a 31-day February (or any other surprise) can't silently shift
// the schedule.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('directory_sync_tasks', (t) => {
    t.text('schedule_kind').notNullable().defaultTo('interval');
    t.text('monthly_day');
  });
  await knex.raw(`
    ALTER TABLE directory_sync_tasks
      ADD CONSTRAINT directory_sync_tasks_schedule_kind_chk
        CHECK (schedule_kind IN ('interval', 'daily', 'weekly', 'monthly')),
      ADD CONSTRAINT directory_sync_tasks_monthly_day_chk
        CHECK (
          monthly_day IS NULL
          OR monthly_day = 'last'
          OR (monthly_day ~ '^[0-9]+$' AND monthly_day::int BETWEEN 1 AND 28)
        ),
      ADD CONSTRAINT directory_sync_tasks_monthly_day_only_when_monthly_chk
        CHECK (schedule_kind = 'monthly' OR monthly_day IS NULL);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE directory_sync_tasks
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_monthly_day_only_when_monthly_chk,
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_monthly_day_chk,
      DROP CONSTRAINT IF EXISTS directory_sync_tasks_schedule_kind_chk;
  `);
  await knex.schema.alterTable('directory_sync_tasks', (t) => {
    t.dropColumn('monthly_day');
    t.dropColumn('schedule_kind');
  });
}
