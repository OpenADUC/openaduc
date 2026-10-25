// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { GraphPermissionError, type GraphResponse } from './graphClient.js';
import {
  issueTap,
  tapPreflight,
  type TapDeps,
  type TapGraph,
  type TapGroup,
  type TapUser,
} from './temporaryAccessPass.js';

const DOMAIN = 'S-1-5-21-850847357-2675788760-1070107763';
// The forest root's domain SID, as a child domain's user carries it.
const FOREST_ROOT = 'S-1-5-21-111111111-222222222-333333333';
const NOW = new Date('2026-10-24T12:00:00Z');
const ENTRA_ID = '071cc716-8147-4397-a5ba-b2105951cc0b';
const GROUP_ID = 'a1b2c3d4-0000-0000-0000-00000000g001';

const alice: TapUser = {
  sid: `${DOMAIN}-1201`,
  displayName: 'Alice Anders',
  samAccountName: 'alice.anders',
  protectedAccount: false,
};

const group = (
  name: string,
  sid: string,
  rawAttributes: Record<string, unknown> = {},
  dn = `CN=${name},OU=Groups,DC=openaduc,DC=test`,
): TapGroup => ({ distinguishedName: dn, name, sid, rawAttributes });
const domainUsers = group('Domain Users', `${DOMAIN}-513`, {}, 'CN=Domain Users,CN=Users,DC=x');
const engineering = group('Engineering', `${DOMAIN}-1106`);

const POLICY = {
  id: 'TemporaryAccessPass',
  state: 'enabled',
  defaultLifetimeInMinutes: 60,
  minimumLifetimeInMinutes: 60,
  maximumLifetimeInMinutes: 480,
  isUsableOnce: false,
  includeTargets: [{ targetType: 'group', id: 'all_users' }],
  excludeTargets: [] as { targetType: string; id: string }[],
};

/** A Graph that answers by path; anything it isn't told about is a test bug. */
class FakeGraph implements TapGraph {
  policy: Record<string, unknown> = { ...POLICY };
  entraUsers: Record<string, unknown>[] = [{ id: ENTRA_ID }];
  memberships: Record<string, unknown>[] = [
    { '@odata.type': '#microsoft.graph.group', id: GROUP_ID },
  ];
  roleAssignments: Record<string, unknown>[] = [{ principalId: 'someone-else' }];
  eligibilities: Record<string, unknown>[] = [];
  /** Paths that answer with this error instead. */
  failing = new Map<string, Error>();
  passes: Record<string, unknown>[] = [];
  lastSync: string | null = '2026-10-24T11:30:00Z';
  posts: { path: string; body: unknown }[] = [];
  gets: string[] = [];

  async getJson<T>(path: string): Promise<GraphResponse<T>> {
    this.gets.push(path);
    for (const [prefix, err] of this.failing) if (path.startsWith(prefix)) throw err;
    if (path.startsWith('/policies/authenticationMethodsPolicy/')) return ok(this.policy);
    if (path.startsWith('/users?$filter=onPremisesSecurityIdentifier')) {
      return ok({ value: this.entraUsers });
    }
    if (path === `/users/${ENTRA_ID}/transitiveMemberOf`) return ok({ value: this.memberships });
    if (path.startsWith('/roleManagement/directory/roleAssignments')) {
      return ok({ value: this.roleAssignments });
    }
    if (path.startsWith('/roleManagement/directory/roleEligibilityScheduleInstances')) {
      return ok({ value: this.eligibilities });
    }
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

/** Token groups as AD gives them: every SID, and the groups found for those it could. */
function token(groups: TapGroup[], unresolvedSids: string[] = []) {
  return { sids: [...groups.map((g) => g.sid!), ...unresolvedSids], groups };
}

function deps(
  graph: FakeGraph,
  tokenGroups: ReturnType<typeof token> | null = token([domainUsers, engineering]),
  roleGroups: TapDeps['roleGroups'] = [],
): TapDeps {
  return { graph, tokenGroups: async () => tokenGroups, roleGroups, now: () => NOW };
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
        inPolicyScope: true,
      },
      entraUserId: ENTRA_ID,
      passes: [],
    });
    expect(graph.gets).toContain(
      `/users?$filter=onPremisesSecurityIdentifier eq '${alice.sid}'&$select=id&$count=true`,
    );
  });

  it('says when the tenant makes every pass single-use', async () => {
    const graph = new FakeGraph();
    graph.policy.isUsableOnce = true;
    const { preflight } = await tapPreflight(deps(graph), alice);
    expect(preflight.status === 'ready' && preflight.policy.usableOnceOnly).toBe(true);
  });

  it('reads the policy once a minute at most', async () => {
    const graph = new FakeGraph();
    await tapPreflight(deps(graph), alice);
    await tapPreflight(deps(graph), alice);
    const later = { ...deps(graph), now: () => new Date(NOW.getTime() + 61_000) };
    await tapPreflight(later, alice);
    expect(graph.gets.filter((p) => p.startsWith('/policies/'))).toHaveLength(2);
  });

  it('says whether the user is among the policy’s targets', async () => {
    const scoped = async (include: string[], exclude: string[] = []) => {
      const graph = new FakeGraph();
      graph.policy.includeTargets = include.map((id) => ({ targetType: 'group', id }));
      graph.policy.excludeTargets = exclude.map((id) => ({ targetType: 'group', id }));
      const { preflight } = await tapPreflight(deps(graph), alice);
      return preflight.status === 'ready' ? preflight.inPolicyScope : 'not ready';
    };
    expect(await scoped([GROUP_ID])).toBe(true);
    expect(await scoped(['another-group'])).toBe(false);
    expect(await scoped(['all_users'], [GROUP_ID])).toBe(false);
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

  describe('refuses an AD administrator before asking Graph', () => {
    const refusal = async (tokenGroups: ReturnType<typeof token> | null, user = alice) => {
      const graph = new FakeGraph();
      const { preflight } = await tapPreflight(deps(graph, tokenGroups), user);
      expect(graph.gets).toEqual([]);
      return preflight;
    };

    it('by a privileged group, nested or not', async () => {
      for (const privileged of [
        group('Domain Admins', `${DOMAIN}-512`),
        group('Account Operators', 'S-1-5-32-548'),
        group('Group Policy Creator Owners', `${DOMAIN}-520`),
        group('Tier 0 Ops', `${DOMAIN}-1300`, { adminCount: '1' }),
        group('DnsAdmins', `${DOMAIN}-1101`, {}, 'CN=DnsAdmins,CN=Users,DC=openaduc,DC=test'),
      ]) {
        expect(await refusal(token([domainUsers, privileged]))).toEqual({
          status: 'refused',
          reason: 'privileged',
          message: expect.stringContaining(`member of ${privileged.name}`),
        });
      }
    });

    it('by its well-known SID, when the group lies outside the base DN or the domain', async () => {
      // Domain Admins under CN=Users, outside an OU base DN, and the forest
      // root's Enterprise Admins: neither is found as a group.
      for (const sid of [`${DOMAIN}-512`, `${FOREST_ROOT}-519`, 'S-1-5-32-544']) {
        expect(await refusal(token([domainUsers], [sid]))).toEqual({
          status: 'refused',
          reason: 'privileged',
          message: expect.stringMatching(
            /member of (Domain Admins|Enterprise Admins|Administrators)/,
          ),
        });
      }
    });

    it('when the account itself is marked adminCount=1', async () => {
      expect(
        await refusal(token([domainUsers]), { ...alice, protectedAccount: true }),
      ).toMatchObject({ status: 'refused', reason: 'privileged' });
    });

    it('when a group can’t be found, or AD wouldn’t say', async () => {
      for (const tokenGroups of [token([domainUsers], [`${FOREST_ROOT}-1500`]), null]) {
        expect(await refusal(tokenGroups)).toMatchObject({
          status: 'refused',
          reason: 'membershipUnknown',
        });
      }
    });
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

  describe('Entra roles', () => {
    const preflightWith = async (setUp: (graph: FakeGraph) => void) => {
      const graph = new FakeGraph();
      setUp(graph);
      return (await tapPreflight(deps(graph), alice)).preflight;
    };

    it('refuses a role held directly, through a group, or eligible in PIM', async () => {
      for (const setUp of [
        (g: FakeGraph) =>
          g.memberships.push({ '@odata.type': '#microsoft.graph.directoryRole', id: 'r1' }),
        (g: FakeGraph) => g.roleAssignments.push({ principalId: ENTRA_ID }),
        (g: FakeGraph) => g.roleAssignments.push({ principalId: GROUP_ID }),
        (g: FakeGraph) => g.eligibilities.push({ principalId: ENTRA_ID }),
        (g: FakeGraph) => g.eligibilities.push({ principalId: GROUP_ID }),
      ]) {
        expect(await preflightWith(setUp)).toMatchObject({
          status: 'refused',
          reason: 'entraAdminRole',
        });
      }
    });

    it('refuses, as unverified, when Graph won’t list them or they run past the page cap', async () => {
      const denied = await preflightWith((g) =>
        g.failing.set(
          '/roleManagement/directory/roleEligibilityScheduleInstances',
          new GraphPermissionError('Graph 403', 403, null, 'RoleManagement.Read.Directory needed'),
        ),
      );
      expect(denied).toEqual({
        status: 'refused',
        reason: 'entraRolesUnknown',
        message: expect.stringContaining('RoleManagement.Read.Directory needed'),
      });

      const endless = await preflightWith((g) => {
        g.roleAssignments = [{ principalId: 'x' }];
        const getJson = g.getJson.bind(g);
        g.getJson = async <T>(path: string) => {
          const res = await getJson<T>(path);
          if (path.includes('roleAssignments')) {
            (res.data as Record<string, unknown>)['@odata.nextLink'] = path;
          }
          return res;
        };
      });
      expect(endless).toMatchObject({ status: 'refused', reason: 'entraRolesUnknown' });
    });

    it('counts no eligibilities in a tenant without PIM licensing, still checking assignments', async () => {
      const unlicensed = (g: FakeGraph) =>
        g.failing.set(
          '/roleManagement/directory/roleEligibilityScheduleInstances',
          new GraphPermissionError(
            'Graph 400: The tenant needs to have Microsoft Entra ID P2 or Microsoft Entra ID Governance license.',
            400,
            'AadPremiumLicenseRequired',
            null,
          ),
        );
      expect((await preflightWith(unlicensed)).status).toBe('ready');
      expect(
        await preflightWith((g) => {
          unlicensed(g);
          g.roleAssignments.push({ principalId: GROUP_ID });
        }),
      ).toMatchObject({ status: 'refused', reason: 'entraAdminRole' });
    });

    it('still refuses as unverified on any other eligibility error', async () => {
      const other = await preflightWith((g) =>
        g.failing.set(
          '/roleManagement/directory/roleEligibilityScheduleInstances',
          new GraphPermissionError('Graph 400: bad request', 400, 'BadRequest', null),
        ),
      );
      expect(other).toMatchObject({ status: 'refused', reason: 'entraRolesUnknown' });
    });
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
      methodId: 'tap-1',
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

  it('starts the pass later when asked, up to 30 days ahead', async () => {
    const graph = new FakeGraph();
    await issueTap(deps(graph), alice, { ...request, startsAt: '2026-10-26T08:00:00Z' });
    expect(graph.posts[0]?.body).toEqual({
      startDateTime: '2026-10-26T08:00:00.000Z',
      lifetimeInMinutes: 120,
      isUsableOnce: true,
    });
    expect(
      await issueTap(deps(graph), alice, { ...request, startsAt: '2026-12-01T08:00:00Z' }),
    ).toMatchObject({ ok: false, code: 'outside_policy' });
    expect(graph.posts).toHaveLength(1);
  });

  it('holds to the tenant policy’s lifetime range and single-use setting', async () => {
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

  it('fits a lifetime within the policy’s range when asked to, rather than refusing it', async () => {
    const graph = new FakeGraph();
    await issueTap(deps(graph), alice, { ...request, lifetimeMinutes: 25, fitLifetime: true });
    await issueTap(deps(graph), alice, { ...request, lifetimeMinutes: 900, fitLifetime: true });
    expect(
      graph.posts.map((p) => (p.body as { lifetimeInMinutes: number }).lifetimeInMinutes),
    ).toEqual([60, 480]);
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

  it('issues nothing to a privileged, unverifiable or unsynced user', async () => {
    const privileged = new FakeGraph();
    expect(
      await issueTap(
        deps(privileged, token([group('Domain Admins', `${DOMAIN}-512`)])),
        alice,
        request,
      ),
    ).toMatchObject({ ok: false, code: 'privileged' });

    const unverified = new FakeGraph();
    unverified.failing.set(
      '/roleManagement/',
      new GraphPermissionError('Graph 403', 403, null, null),
    );
    expect(await issueTap(deps(unverified), alice, request)).toMatchObject({
      ok: false,
      code: 'entra_roles_unknown',
    });

    const unsynced = new FakeGraph();
    unsynced.entraUsers = [];
    expect(await issueTap(deps(unsynced), alice, request)).toMatchObject({
      ok: false,
      code: 'unsynced',
    });
    expect([...privileged.posts, ...unverified.posts, ...unsynced.posts]).toEqual([]);
  });
});
