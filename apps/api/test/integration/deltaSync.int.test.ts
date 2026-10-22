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
});
