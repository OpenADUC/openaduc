// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupLicenses, LicensedGroups, UserLicenses } from '@openaduc/shared';
import { replaceLicensedGroups } from '../../src/services/licenseCache.js';
import { json, token } from './fakeGraph.js';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

// Licenses against the dev DC, with Microsoft Graph played by a fake behind
// fetch: the API's own Graph client, token and all, talks to it.

const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const CUSTOM = '00000000-0000-0000-0000-00000000c0de';
const ALL_PERMISSIONS = ['User.Read.All', 'Group.Read.All', 'Organization.Read.All'];

interface FakeGroup {
  id: string;
  displayName: string;
  onPremisesSecurityIdentifier: string | null;
  assignedLicenses: { skuId: string; disabledPlans: string[] }[];
}

/** Microsoft Graph as far as licenses and the connection test use it. */
class FakeGraph {
  roles = [...ALL_PERMISSIONS];
  /** AD objectSid → Entra user, for the users Connect Sync has synced. */
  users = new Map<string, { id: string; licenseAssignmentStates: unknown[] }>();
  groups: FakeGroup[] = [];
  /** Paths Graph answers as throttled, asking for this many seconds. */
  throttled = new Map<string, number>();
  /** Fail listing the licensed groups, as an outage would. */
  listFails = false;
  requests: string[] = [];

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    this.requests.push(url.toString());
    const headers = new Headers(init.headers);
    if (url.hostname === 'login.microsoftonline.com') {
      return json({ access_token: token(this.roles), expires_in: 3600 });
    }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    const filter = url.searchParams.get('$filter') ?? '';
    const wait = this.throttled.get(path);
    if (wait !== undefined) {
      return json({ error: { code: 'TooManyRequests' } }, 429, { 'Retry-After': String(wait) });
    }
    const sid = /onPremisesSecurityIdentifier eq '([^']+)'/.exec(filter)?.[1];
    if (path === '/organization') {
      return json({
        value: [{ displayName: 'Test Tenant', onPremisesLastSyncDateTime: '2026-10-24T11:30:00Z' }],
      });
    }
    if (path === '/subscribedSkus') {
      return json({ value: [{ skuId: CUSTOM, skuPartNumber: 'CONTOSO_PLAN' }] });
    }
    if (path === '/users') {
      const user = sid ? this.users.get(sid) : undefined;
      return json({ value: user ? [{ id: user.id }] : [] });
    }
    const user = /^\/users\/([^/]+)$/.exec(path);
    if (user) {
      const found = [...this.users.values()].find((u) => u.id === user[1]);
      return found ? json(found) : json({ error: { code: 'Request_ResourceNotFound' } }, 404);
    }
    if (path === '/groups') {
      if (sid) {
        const g = this.groups.find((x) => x.onPremisesSecurityIdentifier === sid);
        return json({ value: g ? [{ id: g.id }] : [] });
      }
      if (filter.startsWith('id in')) {
        return json({ value: this.groups.filter((g) => filter.includes(`'${g.id}'`)) });
      }
      if (filter === 'assignedLicenses/$count ne 0') {
        // Graph refuses a $count filter that isn't an advanced query.
        if (
          headers.get('ConsistencyLevel') !== 'eventual' ||
          url.searchParams.get('$count') !== 'true'
        ) {
          return json({ error: { code: 'Request_UnsupportedQuery' } }, 400);
        }
        if (this.listFails) return json({ error: { code: 'InternalServerError' } }, 500);
        return json({ value: this.groups.filter((g) => g.assignedLicenses.length > 0) });
      }
    }
    const group = /^\/groups\/([^/]+)$/.exec(path);
    if (group) {
      const g = this.groups.find((x) => x.id === group[1]);
      return g
        ? json({ ...g, licenseProcessingState: { state: 'ProcessingComplete' } })
        : json({ error: { code: 'Request_ResourceNotFound' } }, 404);
    }
    return json({ error: { code: 'Request_ResourceNotFound', message: path } }, 404);
  };
}

describe('Licenses', () => {
  let api: TestApi;
  let admin: TestClient;
  let auditor: TestClient;
  let graph: FakeGraph;
  const users: Record<string, { id: string; sid: string }> = {};
  const groups: Record<string, { id: string; sid: string }> = {};

  const engineering = (): FakeGroup => ({
    id: 'entra-engineering',
    displayName: 'Engineering',
    onPremisesSecurityIdentifier: groups['Engineering']!.sid,
    assignedLicenses: [{ skuId: E3, disabledPlans: ['plan-a'] }],
  });
  const userLicenses = async (client: TestClient, who: string) => {
    const res = await client.get(`/api/users/${users[who]!.id}/licenses`);
    return { res, body: res.json<UserLicenses>() };
  };

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api);
    await api.app.services.entraIntegration.create(api.directoryId!, {
      tenantId: '11111111-2222-4333-8444-555555555555',
      clientId: 'client',
      clientSecret: 'not-a-real-secret',
      features: { licenses: true },
    });
    await api.app.services.syncTasks.ensureSeeded(api.directoryId!, { hasEntra: true });
    for (const r of await api.app.db
      .selectFrom('user_cache_records')
      .select(['object_guid', 'sid', 'sam_account_name'])
      .where('provider_id', '=', api.directoryId!)
      .where('sam_account_name', 'in', ['alice.anders', 'bob.baker'])
      .execute()) {
      users[r.sam_account_name!] = { id: r.object_guid, sid: r.sid! };
    }
    for (const r of await api.app.db
      .selectFrom('group_cache_records')
      .select(['object_guid', 'sid', 'name'])
      .where('provider_id', '=', api.directoryId!)
      .where('name', 'in', ['Engineering', 'All Staff'])
      .execute()) {
      groups[r.name!] = { id: r.object_guid, sid: r.sid! };
    }
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
  });
  beforeEach(() => {
    graph = new FakeGraph();
    graph.groups = [
      engineering(),
      {
        id: 'entra-cloud',
        displayName: 'Cloud Licensing',
        onPremisesSecurityIdentifier: null,
        assignedLicenses: [{ skuId: CUSTOM, disabledPlans: [] }],
      },
    ];
    graph.users.set(users['alice.anders']!.sid, {
      id: 'entra-alice',
      licenseAssignmentStates: [
        { skuId: E3, assignedByGroup: 'entra-engineering', state: 'Active', error: 'None' },
        {
          skuId: CUSTOM,
          assignedByGroup: null,
          state: 'Error',
          error: 'CountViolation',
          disabledPlans: [],
        },
      ],
    });
    vi.stubGlobal('fetch', graph.fetch);
    api.app.services.graphClient.invalidateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('are shown on the user’s and the group’s page', async () => {
    const res = await auditor.get(`/api/users/${users['alice.anders']!.id}`);
    expect(res.json()).toMatchObject({ user: { entra: { licenses: true } } });
    const group = await auditor.get(`/api/groups/${groups['Engineering']!.id}`);
    expect(group.json()).toMatchObject({ group: { entra: { licenses: true } } });
  });

  it('say Microsoft Graph is busy when it throttles past what OpenADUC waits for', async () => {
    graph.throttled.set('/users/entra-alice', 60);
    const { res, body } = await userLicenses(auditor, 'alice.anders');
    expect(res.statusCode).toBe(503);
    expect(body).toMatchObject({
      error: {
        code: 'entra_throttled',
        message: 'Microsoft Graph is busy. Try again in a minute.',
        details: { retryAfterSeconds: 60 },
      },
    });
  });

  it('name each of a user’s licenses, the AD group it comes from or that it’s direct, and its error', async () => {
    const { res, body } = await userLicenses(auditor, 'alice.anders');
    expect(res.statusCode).toBe(200);
    expect(body).toEqual({
      status: 'synced',
      licenses: [
        {
          skuId: CUSTOM,
          skuPartNumber: 'CONTOSO_PLAN',
          name: 'CONTOSO_PLAN',
          assignments: [
            {
              group: null,
              state: 'error',
              error: 'CountViolation',
              disabledPlanCount: 0,
              lastUpdatedAt: null,
            },
          ],
        },
        {
          skuId: E3,
          skuPartNumber: null,
          name: 'Microsoft 365 E3',
          assignments: [
            {
              group: {
                entraGroupId: 'entra-engineering',
                name: 'Engineering',
                groupId: groups['Engineering']!.id,
              },
              state: 'active',
              error: null,
              disabledPlanCount: 0,
              lastUpdatedAt: null,
            },
          ],
        },
      ],
    });
  });

  it('say an unsynced user is waiting for sync, with the last sync', async () => {
    const { body } = await userLicenses(auditor, 'bob.baker');
    expect(body).toEqual({ status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' });
  });

  it('show what a group grants, read live, and badge it in pickers from then on', async () => {
    await api.app.db.deleteFrom('entra_group_licenses').execute();
    const before = (await auditor.get('/api/groups/licensed')).json<LicensedGroups>();
    expect(before).toMatchObject({ enabled: true, groups: [] });

    const res = await auditor.get(`/api/groups/${groups['Engineering']!.id}/licenses`);
    expect(res.statusCode).toBe(200);
    expect(res.json<GroupLicenses>()).toEqual({
      status: 'synced',
      licenses: [
        { skuId: E3, skuPartNumber: null, name: 'Microsoft 365 E3', disabledPlanCount: 1 },
      ],
      processingState: 'ProcessingComplete',
    });
    expect((await auditor.get('/api/groups/licensed')).json<LicensedGroups>().groups).toEqual([
      {
        id: groups['Engineering']!.id,
        licenses: [{ skuId: E3, skuPartNumber: null, name: 'Microsoft 365 E3' }],
      },
    ]);
  });

  it('say an unsynced group is waiting for sync', async () => {
    const res = await auditor.get(`/api/groups/${groups['All Staff']!.id}/licenses`);
    expect(res.json()).toEqual({ status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' });
  });

  it('badge every licensed AD group in pickers once the task has read them', async () => {
    await api.app.db.deleteFrom('entra_group_licenses').execute();
    const run = await api.app.services.sync.runOnce(api.directoryId!, 'entra.licenses.groups');
    expect(run).toMatchObject({ ok: true });

    const licensed = (await auditor.get('/api/groups/licensed')).json<LicensedGroups>();
    expect(licensed.refreshedAt).not.toBeNull();
    // The cloud-only group has no AD group to badge.
    expect(licensed.groups).toEqual([
      {
        id: groups['Engineering']!.id,
        licenses: [{ skuId: E3, skuPartNumber: null, name: 'Microsoft 365 E3' }],
      },
    ]);

    graph.groups = [{ ...engineering(), assignedLicenses: [] }];
    await api.app.services.sync.runOnce(api.directoryId!, 'entra.licenses.groups');
    expect((await auditor.get('/api/groups/licensed')).json<LicensedGroups>().groups).toEqual([]);
  });

  it('keep the badges they had, and say the refresh failed, when the task can’t read Entra', async () => {
    await api.app.services.sync.runOnce(api.directoryId!, 'entra.licenses.groups');
    const before = (await auditor.get('/api/groups/licensed')).json<LicensedGroups>();
    expect(before).toMatchObject({ refreshFailed: false });

    graph.listFails = true;
    const run = await api.app.services.sync.runOnce(api.directoryId!, 'entra.licenses.groups');
    expect(run).toMatchObject({ ok: false });
    const after = (await auditor.get('/api/groups/licensed')).json<LicensedGroups>();
    expect(after).toEqual({ ...before, refreshFailed: true });
  });

  it('store a tenant’s worth of licensed groups', async () => {
    const many = Array.from({ length: 15_000 }, (_, i) => ({
      entraGroupId: `entra-${i}`,
      displayName: `Group ${i}`,
      onPremisesSid: null,
      skus: [{ skuId: E3, skuPartNumber: null, disabledPlanCount: 0 }],
    }));
    await replaceLicensedGroups(api.app.db, api.directoryId!, many);
    const { count } = await api.app.db
      .selectFrom('entra_group_licenses')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('provider_id', '=', api.directoryId!)
      .executeTakeFirstOrThrow();
    expect(Number(count)).toBe(15_000);
    await api.app.db.deleteFrom('entra_group_licenses').execute();
  });

  it('are unavailable until the feature is turned on', async () => {
    await api.app.services.entraIntegration.update(api.directoryId!, {
      features: { licenses: false },
    });
    try {
      const { res, body } = await userLicenses(auditor, 'alice.anders');
      expect(res.statusCode).toBe(409);
      expect(body).toMatchObject({ error: { code: 'licenses_not_enabled' } });
      expect(
        (await auditor.get(`/api/groups/${groups['Engineering']!.id}/licenses`)).statusCode,
      ).toBe(409);
      expect((await auditor.get('/api/groups/licensed')).json()).toEqual({
        enabled: false,
        refreshedAt: null,
        refreshFailed: false,
        groups: [],
      });
      const page = await auditor.get(`/api/users/${users['alice.anders']!.id}`);
      expect(page.json()).toMatchObject({ user: { entra: { licenses: false } } });
    } finally {
      await api.app.services.entraIntegration.update(api.directoryId!, {
        features: { licenses: true },
      });
    }
  });

  it('need the read permissions the connection test names', async () => {
    graph.roles = ['Organization.Read.All'];
    const res = await admin.post(`/api/directories/${api.directoryId}/entra/test`);
    expect(res.json()).toMatchObject({
      ok: false,
      missingPermissions: ['User.Read.All', 'Group.Read.All'],
    });

    graph.roles = ['User.Read.All', 'Group.Read.All'];
    expect(
      (await admin.post(`/api/directories/${api.directoryId}/entra/test`)).json(),
    ).toMatchObject({ ok: false, missingPermissions: ['Organization.Read.All'] });

    graph.roles = ['Directory.Read.All'];
    expect(
      (await admin.post(`/api/directories/${api.directoryId}/entra/test`)).json(),
    ).toMatchObject({ ok: true, missingPermissions: [] });
  });
});
