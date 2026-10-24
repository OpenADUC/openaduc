// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// What a job acts with besides its rows, such as the groups a membership
// job adds users to, so its progress and result can name them. A nullable
// column without a default is a catalogue change only.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bulk_jobs', (t) => {
    t.jsonb('subject_json');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bulk_jobs', (t) => {
    t.dropColumn('subject_json');
  });
}
