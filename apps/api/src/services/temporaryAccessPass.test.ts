// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { GraphResponse } from './graphClient.js';
import {
  issueTap,
  tapPreflight,
  type TapDeps,
  type TapGraph,
  type TapGroup,
  type TapUser,
} from './temporaryAccessPass.js';

const DOMAIN = 'S-1-5-21-850847357-2675788760-1070107763';
const NOW = new Date('2026-10-24T12:00:00Z');
const ENTRA_ID = '071cc716-8147-4397-a5ba-b2105951cc0b';

const alice: TapUser = {
  sid: `${DOMAIN}-1201`,
  displayName: 'Alice Anders',
  samAccountName: 'alice.anders',
};

const group = (name: string, rid: number, rawAttributes: Record<string, unknown> = {}) => ({
  distinguishedName: `CN=${name},OU=Groups,DC=openaduc,DC=test`,
  name,
  sid: `${DOMAIN}-${rid}`,
  rawAttributes,
});
const domainUsers = group('Domain Users', 513);
const engineering = group('Engineering', 1106);

const POLICY = {
  id: 'TemporaryAccessPass',
  state: 'enabled',
  defaultLifetimeInMinutes: 60,
  minimumLifetimeInMinutes: 60,
  maximumLifetimeInMinutes: 480,
  isUsableOnce: false,
};

/** A Graph that answers by path; anything it isn't told about is a test bug. */
class FakeGraph implements TapGraph {
  policy: Record<string, unknown> = { ...POLICY };
  entraUsers: Record<string, unknown>[] = [{ id: ENTRA_ID, userPrincipalName: 'alice@x.test' }];
  memberships: Record<string, unknown>[] = [{ '@odata.type': '#microsoft.graph.group', id: 'g1' }];
  passes: Record<string, unknown>[] = [];
  lastSync: string | null = '2026-10-24T11:30:00Z';
  posts: { path: string; body: unknown }[] = [];
  gets: string[] = [];

  async getJson<T>(path: string): Promise<GraphResponse<T>> {
    this.gets.push(path);
    if (path.startsWith('/policies/authenticationMethodsPolicy/')) return ok(this.policy);
    if (path.startsWith('/users?$filter=onPremisesSecurityIdentifier')) {
      return ok({ value: this.entraUsers });
    }
    if (path === `/users/${ENTRA_ID}/transitiveMemberOf`) return ok({ value: this.memberships });
    if (path === `/users/${ENTRA_ID}/authentication/temporaryAccessPassMethods`) {
      return ok({ value: this.passes });
    }
    if (path.startsWith('/organization')) {
      return ok({ value: [{ onPremisesLastSyncDateTime: this.lastSync }] });
    }
    throw new Error(`unexpected GET ${path}`);
  }

  async postJson<T>(path: string, body: unknown): Promise<GraphResponse<T>> {
    this.posts.push({ path, body });
    const b = body as { startDateTime?: string; lifetimeInMinutes: number; isUsableOnce: boolean };
    return ok({
      id: 'tap-1',
      temporaryAccessPass: '+drkzqAD',
      createdDateTime: NOW.toISOString(),
      startDateTime: b.startDateTime ?? NOW.toISOString(),
      lifetimeInMinutes: b.lifetimeInMinutes,
      isUsableOnce: b.isUsableOnce,
    });
  }
}

function ok<T>(data: unknown): GraphResponse<T> {
  return { status: 200, ok: true, data: data as T, headers: new Headers() };
}

function deps(
  graph: FakeGraph,
  groups: TapGroup[] | null = [domainUsers, engineering],
  roleGroups: TapDeps['roleGroups'] = [],
): TapDeps {
  return { graph, groups: async () => groups, roleGroups, now: () => NOW };
}

const request = {
  startsAt: null,
  lifetimeMinutes: 120,
  isUsableOnce: true,
  replaceExisting: false,
};

describe('tapPreflight', () => {
  it('is ready within the tenant policy’s limits', async () => {
    const graph = new FakeGraph();
    expect(await tapPreflight(deps(graph), alice)).toEqual({
      preflight: {
        status: 'ready',
        policy: {
          defaultLifetimeMinutes: 60,
          minLifetimeMinutes: 60,
          maxLifetimeMinutes: 480,
          usableOnceOnly: false,
        },
        existing: null,
      },
      entraUserId: ENTRA_ID,
    });
    expect(graph.gets).toContain(
      `/users?$filter=onPremisesSecurityIdentifier eq '${alice.sid}'&$select=id,userPrincipalName&$count=true`,
    );
  });

  it('says when the tenant makes every pass one-time', async () => {
    const graph = new FakeGraph();
    graph.policy.isUsableOnce = true;
    const { preflight } = await tapPreflight(deps(graph), alice);
    expect(preflight.status === 'ready' && preflight.policy.usableOnceOnly).toBe(true);
  });

  it('shows the pass the user already holds', async () => {
    const graph = new FakeGraph();
    graph.passes = [
      {
        id: 'old',
        temporaryAccessPass: null,
        createdDateTime: '2026-10-24T11:00:00Z',
        startDateTime: '2026-10-24T11:00:00Z',
        lifetimeInMinutes: 480,
        isUsableOnce: false,
        isUsable: true,
        methodUsabilityReason: 'EnabledByPolicy',
      },
    ];
    const { preflight } = await tapPreflight(deps(graph), alice);
    expect(preflight.status === 'ready' && preflight.existing).toEqual({
      createdAt: '2026-10-24T11:00:00Z',
      startsAt: '2026-10-24T11:00:00Z',
      lifetimeMinutes: 480,
      isUsableOnce: false,
      isUsable: true,
      usabilityReason: 'EnabledByPolicy',
    });
  });

  it('ignores a pass that can no longer be used', async () => {
    const graph = new FakeGraph();
    const old = {
      createdDateTime: '2026-10-23T08:00:00Z',
      startDateTime: '2026-10-23T08:00:00Z',
      lifetimeInMinutes: 60,
      isUsableOnce: true,
    };
    for (const pass of [
      { ...old, isUsable: false, methodUsabilityReason: 'Expired' },
      { ...old, startDateTime: '2026-10-24T11:00:00Z', methodUsabilityReason: 'OneTimeUsed' },
      { ...old, isUsable: null, methodUsabilityReason: null },
    ]) {
      graph.passes = [pass];
      const { preflight } = await tapPreflight(deps(graph), alice);
      expect(preflight.status === 'ready' && preflight.existing).toBeNull();
    }
  });

  it('refuses a member of a group AD protects, nested or not, before asking Graph', async () => {
    for (const privileged of [
      group('Domain Admins', 512),
      { ...group('Account Operators', 548), sid: 'S-1-5-32-548' },
      group('Tier 0 Ops', 1300, { adminCount: '1' }),
    ]) {
      const graph = new FakeGraph();
      const { preflight } = await tapPreflight(deps(graph, [domainUsers, privileged]), alice);
      expect(preflight).toEqual({
        status: 'refused',
        reason: 'privileged',
        message: expect.stringContaining(`member of ${privileged.name}`),
      });
      expect(graph.gets).toEqual([]);
    }
  });

  it('refuses a member of a group mapped to OpenADUC’s admin role, but not to another role', async () => {
    const graph = new FakeGraph();
    const roles = [{ dn: engineering.distinguishedName.toUpperCase(), role: 'admin' as const }];
    const { preflight } = await tapPreflight(deps(graph, undefined, roles), alice);
    expect(preflight).toEqual({
      status: 'refused',
      reason: 'privileged',
      message: expect.stringContaining('OpenADUC’s Admin role'),
    });

    const operator = [{ dn: engineering.distinguishedName, role: 'operator' as const }];
    expect((await tapPreflight(deps(graph, undefined, operator), alice)).preflight.status).toBe(
      'ready',
    );
  });

  it('refuses when AD wouldn’t say which groups the user is in', async () => {
    const { preflight } = await tapPreflight(deps(new FakeGraph(), null), alice);
    expect(preflight).toMatchObject({ status: 'refused', reason: 'membershipUnknown' });
  });

  it('refuses a user who holds an Entra administrator role', async () => {
    const graph = new FakeGraph();
    graph.memberships.push({ '@odata.type': '#microsoft.graph.directoryRole', id: 'r1' });
    const { preflight } = await tapPreflight(deps(graph), alice);
    expect(preflight).toMatchObject({ status: 'refused', reason: 'entraAdminRole' });
  });

  it('refuses when the tenant has Temporary Access Pass turned off', async () => {
    const graph = new FakeGraph();
    graph.policy.state = 'disabled';
    const { preflight } = await tapPreflight(deps(graph), alice);
    expect(preflight).toMatchObject({ status: 'refused', reason: 'policyDisabled' });
  });

  it('says a user not in Entra yet is waiting for sync, with the tenant’s last sync', async () => {
    const graph = new FakeGraph();
    graph.entraUsers = [];
    expect(await tapPreflight(deps(graph), alice)).toEqual({
      preflight: { status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' },
      entraUserId: null,
    });
  });
});

describe('issueTap', () => {
  it('creates the pass Graph-side and hands back its value once', async () => {
    const graph = new FakeGraph();
    const outcome = await issueTap(deps(graph), alice, request);
    expect(graph.posts).toEqual([
      {
        path: `/users/${ENTRA_ID}/authentication/temporaryAccessPassMethods`,
        body: { lifetimeInMinutes: 120, isUsableOnce: true },
      },
    ]);
    expect(outcome).toEqual({
      ok: true,
      entraUserId: ENTRA_ID,
      issued: {
        temporaryAccessPass: '+drkzqAD',
        startsAt: '2026-10-24T12:00:00.000Z',
        expiresAt: '2026-10-24T14:00:00.000Z',
        lifetimeMinutes: 120,
        isUsableOnce: true,
        replaced: false,
      },
    });
  });

  it('starts the pass later when asked', async () => {
    const graph = new FakeGraph();
    await issueTap(deps(graph), alice, { ...request, startsAt: '2026-10-26T08:00:00Z' });
    expect(graph.posts[0]?.body).toEqual({
      startDateTime: '2026-10-26T08:00:00.000Z',
      lifetimeInMinutes: 120,
      isUsableOnce: true,
    });
  });

  it('holds to the tenant policy’s lifetime range and one-time setting', async () => {
    const graph = new FakeGraph();
    graph.policy.isUsableOnce = true;
    expect(await issueTap(deps(graph), alice, { ...request, lifetimeMinutes: 600 })).toEqual({
      ok: false,
      code: 'outside_policy',
      message: 'The tenant’s policy allows a lifetime from 1 hour to 8 hours.',
    });
    expect(await issueTap(deps(graph), alice, { ...request, isUsableOnce: false })).toMatchObject({
      ok: false,
      code: 'outside_policy',
    });
    expect(graph.posts).toEqual([]);
  });

  it('won’t replace the user’s pass unless the operator was warned', async () => {
    const graph = new FakeGraph();
    graph.passes = [
      {
        createdDateTime: '2026-10-24T11:00:00Z',
        startDateTime: '2026-10-24T11:00:00Z',
        lifetimeInMinutes: 480,
        isUsableOnce: false,
        isUsable: true,
        methodUsabilityReason: 'EnabledByPolicy',
      },
    ];
    expect(await issueTap(deps(graph), alice, request)).toMatchObject({
      ok: false,
      code: 'tap_exists',
    });
    expect(graph.posts).toEqual([]);

    const replaced = await issueTap(deps(graph), alice, { ...request, replaceExisting: true });
    expect(replaced.ok && replaced.issued.replaced).toBe(true);
    expect(graph.posts).toHaveLength(1);
  });

  it('issues nothing to a privileged or unsynced user', async () => {
    const privileged = new FakeGraph();
    expect(
      await issueTap(deps(privileged, [group('Domain Admins', 512)]), alice, request),
    ).toMatchObject({ ok: false, code: 'privileged' });

    const unsynced = new FakeGraph();
    unsynced.entraUsers = [];
    expect(await issueTap(deps(unsynced), alice, request)).toMatchObject({
      ok: false,
      code: 'unsynced',
    });
    expect([...privileged.posts, ...unsynced.posts]).toEqual([]);
  });
});
