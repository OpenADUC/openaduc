// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Class Temporary Access Passes (docs/adr/0003-class-taps-are-stored-until-they-expire.md).
// import_classes is the class an import's people get passes for, one per
// import job: when it starts (one time, or each person's start date at a
// time of day, as JSON) and the passes' lifetime and use. class_passes is
// one per import row: whether its pass waits (for the account, or for
// Connect Sync), was issued, or was refused, and the issued pass's value,
// encrypted with the app's secret key and bound to its job and row, until
// it expires or is replaced. next_attempt_at and claim_token let any API
// process take a due pass, and a process that dies holding one lets it go
// when its claim lapses.
//
// Both tables are new, so their indexes are built with them; the foreign
// keys take a brief lock on bulk_jobs and bulk_job_rows.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_classes', (t) => {
    t.bigInteger('job_id').primary().references('id').inTable('bulk_jobs').onDelete('CASCADE');
    t.jsonb('start').notNullable();
    t.integer('lifetime_minutes').notNullable();
    t.boolean('is_usable_once').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('class_passes', (t) => {
    t.bigInteger('row_id').primary().references('id').inTable('bulk_job_rows').onDelete('CASCADE');
    t.bigInteger('job_id')
      .notNullable()
      .references('job_id')
      .inTable('import_classes')
      .onDelete('CASCADE');
    t.text('status').notNullable().defaultTo('waiting');
    // This person's class start; null when it's their start date and they have none.
    t.timestamp('class_starts_at', { useTz: true });
    t.text('entra_user_id');
    // The pass Graph created, so one replaced outside the roster can be told apart.
    t.text('entra_method_id');
    t.text('pass_enc');
    t.timestamp('pass_starts_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.text('error_code');
    t.text('message');
    // When Connect Sync last ran, as Entra said while the person wasn't there yet.
    t.timestamp('tenant_last_sync_at', { useTz: true });
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('claim_token');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['job_id'], 'class_passes_job_idx');
  });
  await knex.raw(`
    ALTER TABLE class_passes
      ADD CONSTRAINT class_passes_status_check
        CHECK (status IN ('waiting', 'issued', 'refused', 'failed'))
  `);
  await knex.raw(
    `CREATE INDEX class_passes_due_idx ON class_passes (next_attempt_at) WHERE status = 'waiting'`,
  );
  await knex.raw(
    'CREATE INDEX class_passes_held_idx ON class_passes (expires_at) WHERE pass_enc IS NOT NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('class_passes');
  await knex.schema.dropTableIfExists('import_classes');
}
