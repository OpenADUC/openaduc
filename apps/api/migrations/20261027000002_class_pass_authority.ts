// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Class passes are made on someone's authority: the import's operator at
// first, then whoever takes the class over or reschedules it. The
// follow-up checks they may still issue passes, and pauses the class
// (authority_lapsed_at) when they can't. An issued pass is checked again
// before class for who its holder has become (its next_attempt_at), and a
// pass a reschedule or reissue replaced is deleted in Entra before the
// new one is made (stale_method_id). Both tables are new and small, so
// the backfill and NOT NULL are quick.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_classes', (t) => {
    t.text('authoriser_user_id');
    t.text('authoriser_display_name');
    t.timestamp('authority_lapsed_at', { useTz: true });
    t.text('authority_message');
  });
  await knex.raw(`
    UPDATE import_classes c
       SET authoriser_user_id = j.actor_user_id, authoriser_display_name = j.actor_display_name
      FROM bulk_jobs j
     WHERE j.id = c.job_id
  `);
  await knex.raw('ALTER TABLE import_classes ALTER COLUMN authoriser_user_id SET NOT NULL');
  await knex.schema.alterTable('class_passes', (t) => {
    t.text('stale_method_id');
  });
  await knex.raw('DROP INDEX class_passes_due_idx');
  await knex.raw(
    `CREATE INDEX class_passes_due_idx ON class_passes (next_attempt_at)
       WHERE status = 'waiting' OR (status = 'issued' AND pass_enc IS NOT NULL)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX class_passes_due_idx');
  await knex.raw(
    `CREATE INDEX class_passes_due_idx ON class_passes (next_attempt_at) WHERE status = 'waiting'`,
  );
  await knex.schema.alterTable('class_passes', (t) => {
    t.dropColumn('stale_method_id');
  });
  await knex.schema.alterTable('import_classes', (t) => {
    t.dropColumn('authority_message');
    t.dropColumn('authority_lapsed_at');
    t.dropColumn('authoriser_display_name');
    t.dropColumn('authoriser_user_id');
  });
}
