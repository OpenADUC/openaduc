// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, startApi, type TestApi } from './harness.js';

describe('a full crawl that finds nothing', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    // A base DN with no users or groups under it: what a service account
    // that lost its list rights would see.
    await api.app.db
      .updateTable('directory_providers')
      .set({ base_dn: `OU=Workstations,OU=OpenADUC Test,${DC.baseDn}` })
      .execute();
  });
  afterAll(async () => {
    await api?.close();
  });

  const staleCount = async (table: 'user_cache_records' | 'group_cache_records') =>
    (await api.app.db.selectFrom(table).select('id').where('stale_at', 'is not', null).execute())
      .length;

  for (const [task, table] of [
    ['users.full', 'user_cache_records'],
    ['groups.full', 'group_cache_records'],
  ] as const) {
    it(`${task} fails instead of marking the whole cache stale`, async () => {
      const result = await api.app.services.sync.runOnce(api.directoryId!, task);

      expect(result.ok).toBe(false);
      expect(await staleCount(table)).toBe(0);
    });
  }
});

describe('two processes', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('never run tasks for the same directory at once', async () => {
    const { SYNC_LOCK_CLASS } = await import('../../src/services/syncTasks/scheduler.js');
    // Another process holding the directory's lock.
    const other = await api.app.pgPool.connect();
    try {
      await other.query('select pg_advisory_lock($1, $2)', [SYNC_LOCK_CLASS, api.directoryId]);
      const blocked = await api.app.services.sync.runOnce(api.directoryId!, 'users.delta');
      expect(blocked).toMatchObject({ ok: false });
      expect(blocked.error).toMatch(/another OpenADUC process/);

      await other.query('select pg_advisory_unlock($1, $2)', [SYNC_LOCK_CLASS, api.directoryId]);
      const allowed = await api.app.services.sync.runOnce(api.directoryId!, 'users.delta');
      expect(allowed.ok).toBe(true);
    } finally {
      other.release();
    }
  });
});

describe('stuck runs', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('resetting a stuck task also closes its run-history row', async () => {
    // What a crash mid-run leaves behind.
    const { runId } = await api.app.services.syncTasks.markStarted(api.directoryId!, 'users.delta');
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    const res = await admin.post(
      `/api/directories/${api.directoryId}/sync-tasks/users.delta/reset`,
    );
    expect(res.statusCode).toBeLessThan(300);

    const run = await api.app.db
      .selectFrom('directory_sync_task_runs')
      .select(['status', 'finished_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).not.toBe('running');
    expect(run.finished_at).not.toBeNull();
  });
});
