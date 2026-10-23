// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// stepup.ttl_minutes (a fixed lifetime, shipped as 60) becomes an idle
// timeout and an absolute lifetime. An installation that changed the TTL
// chose how long write access may last, so its value becomes the absolute
// lifetime and the idle timeout never exceeds it; nobody's elevated session
// gets longer than they configured. Untouched installations get the new
// defaults.
const OLD_KEY = 'stepup.ttl_minutes';
const OLD_DEFAULT = 60;
const IDLE_KEY = 'stepup.idle_timeout_minutes';
const ABSOLUTE_KEY = 'stepup.absolute_lifetime_minutes';
const IDLE_DEFAULT = 15;
const ABSOLUTE_DEFAULT = 240;

export async function up(knex: Knex): Promise<void> {
  const old = (await knex('app_settings')
    .select('value_json', 'updated_by_actor_id')
    .where('key', OLD_KEY)
    .first()) as { value_json: unknown; updated_by_actor_id: string | null } | undefined;
  const ttl = typeof old?.value_json === 'number' ? old.value_json : null;
  const configured = ttl !== null && (ttl !== OLD_DEFAULT || old?.updated_by_actor_id != null);

  const rows = [
    {
      key: IDLE_KEY,
      value: configured ? Math.min(IDLE_DEFAULT, ttl) : IDLE_DEFAULT,
      description:
        'Minutes without activity after which an elevated session ends and writes need step-up again.',
    },
    {
      key: ABSOLUTE_KEY,
      value: configured ? ttl : ABSOLUTE_DEFAULT,
      description:
        'Minutes after step-up at which an elevated session ends however active the operator is.',
    },
  ];
  for (const row of rows) {
    await knex.raw(
      `INSERT INTO app_settings (key, value_json, description, updated_by_actor_id)
       VALUES (?, ?::jsonb, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
      [
        row.key,
        JSON.stringify(row.value),
        row.description,
        configured ? (old?.updated_by_actor_id ?? null) : null,
      ],
    );
  }
  await knex('app_settings').where('key', OLD_KEY).delete();
}

export async function down(knex: Knex): Promise<void> {
  const absolute = (await knex('app_settings')
    .select('value_json')
    .where('key', ABSOLUTE_KEY)
    .first()) as { value_json: unknown } | undefined;
  const value = absolute?.value_json;
  const ttl =
    typeof value === 'number' && value !== ABSOLUTE_DEFAULT ? Math.min(value, 480) : OLD_DEFAULT;
  await knex.raw(
    `INSERT INTO app_settings (key, value_json, description) VALUES (?, ?::jsonb, ?)
     ON CONFLICT (key) DO NOTHING`,
    [OLD_KEY, JSON.stringify(ttl), 'How long an elevated session lasts after step-up.'],
  );
  await knex('app_settings').whereIn('key', [IDLE_KEY, ABSOLUTE_KEY]).delete();
}
