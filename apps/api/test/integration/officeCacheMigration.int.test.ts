// SPDX-License-Identifier: BUSL-1.1
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down, up } from '../../migrations/20261024000003_user_cache_office.js';
import { configureDirectory, startApi, type TestApi } from './harness.js';

describe('caching the office in its own column', () => {
  let api: TestApi;
  let db: Knex;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL! });
    await db('directory_sync_tasks')
      .insert(
        ['users.full', 'groups.full'].map((task_key) => ({
          provider_id: api.directoryId,
          task_key,
        })),
      )
      .onConflict(['provider_id', 'task_key'])
      .ignore();
  });
  afterAll(async () => {
    await db?.destroy();
    await api?.close();
  });

  it('marks rows cached before it as unread, and makes the next full user sync due now', async () => {
    const ran = new Date('2026-10-24T08:00:00Z');
    await db('directory_sync_tasks')
      .where({ task_key: 'users.full' })
      .update({ last_started_at: ran, last_status: 'succeeded' });
    await db('directory_sync_tasks')
      .where({ task_key: 'groups.full' })
      .update({ last_started_at: ran, last_status: 'succeeded' });

    await down(db);
    await up(db);

    const tasks = await db('directory_sync_tasks')
      .select('task_key', 'last_started_at')
      .whereIn('task_key', ['users.full', 'groups.full'])
      .orderBy('task_key');
    expect(tasks).toEqual([
      { task_key: 'groups.full', last_started_at: ran },
      { task_key: 'users.full', last_started_at: null },
    ]);
    const unread = await db('user_cache_records').where({ office_read: true }).count('* as n');
    expect(unread).toEqual([{ n: '0' }]);
  });

  it('leaves a full sync that is running alone', async () => {
    const started = new Date('2026-10-24T09:00:00Z');
    await db('directory_sync_tasks')
      .where({ task_key: 'users.full' })
      .update({ last_started_at: started, last_status: 'running' });

    await down(db);
    await up(db);

    const [task] = await db('directory_sync_tasks')
      .select('last_started_at')
      .where({ task_key: 'users.full' });
    expect(task).toEqual({ last_started_at: started });
  });
});
