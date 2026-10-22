// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  setGroupMember,
  setUserAttribute,
  startApi,
  type TestApi,
} from './harness.js';

const ENGINEERING = 'CN=Engineering,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';

describe('delta sync', () => {
  let api: TestApi;

  const run = async (task: 'users.delta' | 'groups.delta' | 'memberships.rebuild') => {
    const result = await api.app.services.sync.runOnce(api.directoryId!, task);
    expect(result.ok).toBe(true);
    return result.stats ?? {};
  };

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await setGroupMember(ENGINEERING, 'erin.evans', false);
    await setUserAttribute('alice.anders', 'title', ['Engineer']);
    await api?.close();
  });

  it('after one successful run, fetches only what changed since that run started', async () => {
    const first = await run('users.delta'); // no previous success: full crawl
    expect(first.modifiedSince).toBeNull();

    await setUserAttribute('alice.anders', 'title', ['Staff Engineer']);
    const second = await run('users.delta');

    expect(second.modifiedSince).not.toBeNull();
    const cached = await api.app.db
      .selectFrom('user_cache_records')
      .select('title')
      .where('sam_account_name', '=', 'alice.anders')
      .executeTakeFirstOrThrow();
    expect(cached.title).toBe('Staff Engineer');
  });

  const lastRunStart = async (task: string) =>
    (
      await api.app.db
        .selectFrom('directory_sync_task_runs')
        .select('started_at')
        .where('task_key', '=', task)
        .where('status', '=', 'succeeded')
        .orderBy('started_at', 'desc')
        .executeTakeFirstOrThrow()
    ).started_at;
  const fiveMinutesBefore = (d: Date | string) =>
    new Date(new Date(d).getTime() - 5 * 60_000).toISOString();

  it('anchors on when the last success started, so changes made during it are fetched next time', async () => {
    await run('users.delta');
    const started = await lastRunStart('users.delta');

    const next = await run('users.delta');
    expect(next.modifiedSince).toBe(fiveMinutesBefore(started));
  });

  it('after failed runs, still fetches everything since the last success', async () => {
    await run('users.delta');
    const lastSuccess = await lastRunStart('users.delta');
    await api.app.db
      .insertInto('directory_sync_task_runs')
      .values({
        provider_id: api.directoryId!,
        task_key: 'users.delta',
        status: 'failed',
        trigger: 'cadence',
        started_at: new Date(),
        finished_at: new Date(),
        error: 'simulated outage',
      })
      .execute();

    const next = await run('users.delta');
    expect(next.modifiedSince).toBe(fiveMinutesBefore(lastSuccess));
  });

  it('picks up a user added to a group, though only the group changed', async () => {
    await run('groups.delta'); // establish a successful run
    await setGroupMember(ENGINEERING, 'erin.evans', true);

    // No users.delta: the user object itself didn't change.
    const groups = await run('groups.delta');
    expect(groups.membersRefreshed).toBeGreaterThan(0);
    await run('memberships.rebuild');

    const memberships = await api.app.db
      .selectFrom('user_group_memberships as m')
      .innerJoin('user_cache_records as u', 'u.object_guid', 'm.user_object_guid')
      .innerJoin('group_cache_records as g', 'g.object_guid', 'm.group_object_guid')
      .select('g.name')
      .where('u.sam_account_name', '=', 'erin.evans')
      .execute();
    expect(memberships.map((m) => m.name)).toContain('Engineering');
  });

  it('drops a user removed from a group, though only the group changed', async () => {
    await setGroupMember(ENGINEERING, 'erin.evans', false);
    await run('groups.delta');
    await run('memberships.rebuild');

    const memberships = await api.app.db
      .selectFrom('user_group_memberships as m')
      .innerJoin('user_cache_records as u', 'u.object_guid', 'm.user_object_guid')
      .innerJoin('group_cache_records as g', 'g.object_guid', 'm.group_object_guid')
      .select('g.name')
      .where('u.sam_account_name', '=', 'erin.evans')
      .execute();
    expect(memberships.map((m) => m.name)).not.toContain('Engineering');
  });
});
