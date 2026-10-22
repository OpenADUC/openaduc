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
    const { SYNC_LOCK_CLASS } = await import('../../src/lib/advisoryLocks.js');
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

describe('two runs in one process', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('the second is turned away as already running here', async () => {
    const [a, b] = await Promise.all([
      api.app.services.sync.runOnce(api.directoryId!, 'users.delta'),
      api.app.services.sync.runOnce(api.directoryId!, 'groups.delta'),
    ]);
    const refused = [a, b].filter((r) => !r.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error).toMatch(/another task is running/);
  });
});

describe('a database pool with one connection', () => {
  let api: TestApi;

  beforeAll(async () => {
    // The directory lock is held for the whole task; if it came out of the
    // pool the task's own queries use, N tasks on an N-connection pool
    // would wait on each other forever. One connection is the smallest N.
    process.env.DATABASE_POOL_MAX = '1';
    api = await startApi();
  });
  afterAll(async () => {
    delete process.env.DATABASE_POOL_MAX;
    await api?.close();
  });

  it('still runs sync tasks', { timeout: 30_000 }, async () => {
    await configureDirectory(api);
    const result = await api.app.services.sync.runOnce(api.directoryId!, 'users.delta');
    expect(result.ok).toBe(true);
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

describe('rebuilding group memberships', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  const membershipCount = async () =>
    (await api.app.db.selectFrom('user_group_memberships').select('provider_id').execute()).length;

  it('never shows readers an empty table part-way through', async () => {
    const before = await membershipCount();
    expect(before).toBeGreaterThan(0);

    // Stall the rebuild after its delete: its insert reads the group cache,
    // which another session holds locked.
    const blocker = await api.app.pgPool.connect();
    let rebuild: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE group_cache_records IN ACCESS EXCLUSIVE MODE');
      rebuild = api.app.services.sync.runOnce(api.directoryId!, 'memberships.rebuild');
      for (let i = 0; ; i++) {
        const waiting = await blocker.query(
          "select 1 from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'group_cache_records' and not l.granted",
        );
        if (waiting.rowCount) break;
        if (i > 100) throw new Error('rebuild never reached the group cache');
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(await membershipCount()).toBe(before);
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    expect(await rebuild).toMatchObject({ ok: true });
    expect(await membershipCount()).toBe(before);
  });
});
