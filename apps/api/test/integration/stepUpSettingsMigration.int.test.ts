// SPDX-License-Identifier: BUSL-1.1
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up } from '../../migrations/20261023000003_stepup_idle_and_absolute_settings.js';
import { startApi, type TestApi } from './harness.js';

describe('migrating the fixed step-up TTL to idle and absolute limits', () => {
  let api: TestApi;
  let db: Knex;

  beforeAll(async () => {
    api = await startApi();
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL! });
  });
  afterAll(async () => {
    await db?.destroy();
    await api?.close();
  });

  async function migrateFrom(ttl: number, updatedBy: string | null) {
    await db('app_settings')
      .whereIn('key', ['stepup.idle_timeout_minutes', 'stepup.absolute_lifetime_minutes'])
      .delete();
    await db('app_settings').insert({
      key: 'stepup.ttl_minutes',
      value_json: JSON.stringify(ttl),
      updated_by_actor_id: updatedBy,
    });
    await up(db);
    const rows = await db('app_settings')
      .select('key', 'value_json')
      .whereLike('key', 'stepup.%')
      .orderBy('key');
    return Object.fromEntries(
      rows.map((r: { key: string; value_json: unknown }) => [r.key, r.value_json]),
    );
  }

  it.each([
    { from: 'the shipped default', ttl: 60, by: null, idle: 15, absolute: 240 },
    { from: 'an explicitly chosen 60', ttl: 60, by: 'someone', idle: 15, absolute: 60 },
    { from: 'a longer TTL', ttl: 480, by: 'someone', idle: 15, absolute: 480 },
    { from: 'a TTL under the idle default', ttl: 10, by: 'someone', idle: 10, absolute: 10 },
  ])('from $from, never lets a session last longer than it could', async (c) => {
    expect(await migrateFrom(c.ttl, c.by)).toEqual({
      'stepup.absolute_lifetime_minutes': c.absolute,
      'stepup.idle_timeout_minutes': c.idle,
    });
  });
});
