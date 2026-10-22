// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, startApi, type TestApi } from './harness.js';

// More than Postgres's 65,535 bind-parameter limit.
const MANY = 70_000;

describe('stale-marking after a full crawl of a large directory', () => {
  let api: TestApi;
  let seen: Set<string>;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    seen = new Set(Array.from({ length: MANY }, () => randomUUID()));
  });
  afterAll(async () => {
    await api?.close();
  });

  it('works for users, groups, computers and group policies', async () => {
    const { markUsersStale } = await import('../../src/services/userCache.js');
    const { markGroupsStale } = await import('../../src/services/groupCache.js');
    const { markComputersStale } = await import('../../src/services/computerCache.js');
    const { markGroupPoliciesStale } = await import('../../src/services/groupPolicyCache.js');
    const { markOusStale } = await import('../../src/services/ouCache.js');
    const id = api.directoryId!;

    await expect(markUsersStale(api.app.db, id, seen)).resolves.not.toThrow();
    await expect(markGroupsStale(api.app.db, id, seen)).resolves.not.toThrow();
    await expect(markComputersStale(api.app.db, id, seen)).resolves.not.toThrow();
    await expect(markGroupPoliciesStale(api.app.db, id, seen)).resolves.not.toThrow();
    await expect(
      markOusStale(api.app.db, id, new Set([...seen].map((g) => `ou=${g},dc=x`))),
    ).resolves.not.toThrow();

    const { clearLockedExcept } = await import('../../src/services/userCache.js');
    await api.app.db
      .updateTable('user_cache_records')
      .set({ locked: true })
      .where('sam_account_name', '=', 'alice.anders')
      .execute();
    // alice's GUID isn't in `seen`, so she's no longer locked.
    expect(await clearLockedExcept(api.app.db, id, seen, new Date().toISOString())).toBeGreaterThan(
      0,
    );

    // None of the cached objects were in `seen`, so all are now stale.
    const fresh = await api.app.db
      .selectFrom('user_cache_records')
      .select('id')
      .where('stale_at', 'is', null)
      .execute();
    expect(fresh).toEqual([]);
  });
});

describe('paged directory reads', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('return every entry across many small pages', async () => {
    const provider = await api.app.services.providers.buildWithCreds(api.directoryId!, {
      username: `${DC.serviceAccount}@${DC.domain}`,
      password: DC.password,
    });
    const sams: string[] = [];
    for await (const user of provider.syncUsers({ pageSize: 2 })) sams.push(user.samAccountName!);
    expect(sams.length).toBeGreaterThan(10);
    expect(new Set(sams).size).toBe(sams.length);
  });
});
