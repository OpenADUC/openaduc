// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

type Freshness = { lastSyncedAt: string | null; stale: boolean };

describe('list freshness', () => {
  let api: TestApi;
  let operator: TestClient;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api); // initial sync: users, groups, computers
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
  });
  afterAll(async () => {
    await api?.close();
  });

  const freshness = async (list: 'users' | 'groups' | 'computers') =>
    (await operator.get(`/api/${list}`)).json<{ freshness: Freshness }>().freshness;

  it('says when each list was last synced', async () => {
    for (const list of ['users', 'groups', 'computers'] as const) {
      const f = await freshness(list);
      expect(f.stale).toBe(false);
      expect(Date.now() - new Date(f.lastSyncedAt!).getTime()).toBeLessThan(10 * 60_000);
    }
  });

  it('flags a list whose sync is overdue', async () => {
    await api.app.db
      .updateTable('directory_sync_task_runs')
      .set({ finished_at: new Date(Date.now() - 3 * 86_400_000) })
      .where('task_key', 'like', 'users.%')
      .execute();

    const f = await freshness('users');
    expect(f.stale).toBe(true);
    expect((await freshness('groups')).stale).toBe(false);
  });
});
