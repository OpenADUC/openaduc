// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { GraphPermissionError, type GraphResponse } from './graphClient.js';
import type { GraphReader } from './entraLookup.js';
import {
  groupLicenses,
  licensedEntraGroups,
  userLicenses,
  type LicenseDeps,
} from './entraLicenses.js';

const SID = 'S-1-5-21-850847357-2675788760-1070107763-1201';
const GROUP_SID = 'S-1-5-21-850847357-2675788760-1070107763-1106';
const USER_ID = '071cc716-8147-4397-a5ba-b2105951cc0b';
const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const VISIO = 'c5928f49-12ba-48f7-ada3-0d743a3601d5';
const CUSTOM = '00000000-0000-0000-0000-00000000c0de';
const ENGINEERING = {
  id: 'entra-eng',
  displayName: 'Engineering',
  onPremisesSecurityIdentifier: GROUP_SID,
};
const CLOUD = {
  id: 'entra-cloud',
  displayName: 'Cloud Licensing',
  onPremisesSecurityIdentifier: null,
};
const AD_ENGINEERING = '6f1b2c3d-0000-4000-8000-000000000106';

/** A Graph that answers by path; anything it isn't told about is a test bug. */
class FakeGraph implements GraphReader {
  users = new Map<string, string>([[SID, USER_ID]]);
  states: Record<string, unknown>[] = [];
  groups: Record<string, unknown>[] = [ENGINEERING, CLOUD];
  skus: Record<string, unknown>[] = [
    { skuId: E3, skuPartNumber: 'SPE_E3' },
    { skuId: CUSTOM, skuPartNumber: 'CONTOSO_PLAN' },
  ];
  failing = new Map<string, Error>();
  gets: string[] = [];

  headers = new Map<string, Record<string, string> | undefined>();

  async getJson<T>(
    path: string,
    opts?: { headers?: Record<string, string> },
  ): Promise<GraphResponse<T>> {
    this.gets.push(path);
    this.headers.set(path, opts?.headers);
    for (const [prefix, err] of this.failing) if (path.startsWith(prefix)) throw err;
    const sid = /onPremisesSecurityIdentifier eq '([^']+)'/.exec(path)?.[1];
    if (path.startsWith('/users?$filter=')) {
      const id = sid && this.users.get(sid);
      return ok({ value: id ? [{ id }] : [] });
    }
    if (path === `/users/${USER_ID}?$select=id,licenseAssignmentStates`) {
      return ok({ id: USER_ID, licenseAssignmentStates: this.states });
    }
    if (path.startsWith('/groups?$filter=onPremisesSecurityIdentifier')) {
      const g = this.groups.find((x) => x.onPremisesSecurityIdentifier === sid);
      return ok({ value: g ? [{ id: g.id }] : [] });
    }
    if (path.startsWith('/groups?$filter=id in')) {
      return ok({ value: this.groups.filter((g) => path.includes(`'${String(g.id)}'`)) });
    }
    if (path.startsWith('/groups?$filter=assignedLicenses/$count ne 0&$count=true&')) {
      return ok({ value: this.groups.filter((g) => Array.isArray(g.assignedLicenses)) });
    }
    const one = /^\/groups\/([^?]+)\?/.exec(path)?.[1];
    if (one) return ok(this.groups.find((g) => g.id === one));
    if (path.startsWith('/subscribedSkus')) return ok({ value: this.skus });
    if (path.startsWith('/organization')) {
      return ok({ value: [{ onPremisesLastSyncDateTime: '2026-10-24T11:30:00Z' }] });
    }
    throw new Error(`unexpected GET ${path}`);
  }
}

function ok<T>(data: unknown): GraphResponse<T> {
  return { status: 200, ok: true, data: data as T, headers: new Headers() };
}

function deps(graph: FakeGraph): LicenseDeps {
  return {
    graph,
    adGroupsBySid: async (sids) =>
      new Map(sids.filter((s) => s === GROUP_SID).map((s) => [s, AD_ENGINEERING])),
  };
}

const state = (
  skuId: string,
  assignedByGroup: string | null,
  extra: Record<string, unknown> = {},
) => ({
  skuId,
  assignedByGroup,
  state: 'Active',
  error: 'None',
  disabledPlans: [],
  lastUpdatedDateTime: '2026-10-20T09:00:00Z',
  ...extra,
});

describe('userLicenses', () => {
  it('names each product and says whether it comes from a group, linked to its AD group, or directly', async () => {
    const graph = new FakeGraph();
    graph.states = [
      state(E3, ENGINEERING.id),
      state(E3, null, { disabledPlans: ['plan-a', 'plan-b'] }),
      state(VISIO, CLOUD.id),
    ];
    const result = await userLicenses(deps(graph), SID);
    expect(result).toEqual({
      status: 'synced',
      licenses: [
        {
          skuId: E3,
          skuPartNumber: 'SPE_E3',
          name: 'Microsoft 365 E3',
          assignments: [
            {
              group: null,
              state: 'active',
              error: null,
              disabledPlanCount: 2,
              lastUpdatedAt: '2026-10-20T09:00:00.000Z',
            },
            {
              group: { entraGroupId: ENGINEERING.id, name: 'Engineering', groupId: AD_ENGINEERING },
              state: 'active',
              error: null,
              disabledPlanCount: 0,
              lastUpdatedAt: '2026-10-20T09:00:00.000Z',
            },
          ],
        },
        {
          skuId: VISIO,
          skuPartNumber: null,
          name: 'Visio Plan 2',
          assignments: [
            expect.objectContaining({
              group: { entraGroupId: CLOUD.id, name: 'Cloud Licensing', groupId: null },
            }),
          ],
        },
      ],
    });
  });

  it('says why Entra couldn’t assign a license', async () => {
    const graph = new FakeGraph();
    graph.states = [
      state(E3, ENGINEERING.id, { state: 'Error', error: 'CountViolation' }),
      state(CUSTOM, null, {
        state: 'ActiveWithError',
        error: 'ProhibitedInUsageLocationViolation',
      }),
      state(VISIO, null, { state: 'Error', error: 'SomethingNew' }),
    ];
    const result = await userLicenses(deps(graph), SID);
    if (result.status !== 'synced') throw new Error('expected synced');
    const byName = Object.fromEntries(
      result.licenses.map((l) => [l.name, l.assignments.map((a) => [a.state, a.error])]),
    );
    expect(byName).toEqual({
      'Microsoft 365 E3': [['error', 'CountViolation']],
      CONTOSO_PLAN: [['activeWithError', 'ProhibitedInUsageLocationViolation']],
      'Visio Plan 2': [['error', 'Other']],
    });
  });

  it('says a user who isn’t in Entra yet is waiting for sync', async () => {
    const graph = new FakeGraph();
    graph.users.clear();
    expect(await userLicenses(deps(graph), SID)).toEqual({
      status: 'unsynced',
      lastSyncAt: '2026-10-24T11:30:00.000Z',
    });
  });

  it('keeps a license whose group Entra won’t describe, and part numbers it can’t read', async () => {
    const graph = new FakeGraph();
    graph.states = [state(CUSTOM, ENGINEERING.id)];
    const denied = new GraphPermissionError('Graph 403', 403, 'Authorization_RequestDenied', null);
    graph.failing.set('/groups?', denied).set('/subscribedSkus', denied);
    const result = await userLicenses(deps(graph), SID);
    expect(result).toMatchObject({
      status: 'synced',
      licenses: [
        {
          skuId: CUSTOM,
          skuPartNumber: null,
          name: CUSTOM,
          assignments: [{ group: { entraGroupId: ENGINEERING.id, name: null, groupId: null } }],
        },
      ],
    });
  });
});

describe('groupLicenses', () => {
  it('lists what a synced group grants, with its processing state', async () => {
    const graph = new FakeGraph();
    graph.groups = [
      {
        ...ENGINEERING,
        assignedLicenses: [
          { skuId: E3, disabledPlans: ['plan-a'] },
          { skuId: CUSTOM, disabledPlans: [] },
        ],
        licenseProcessingState: { state: 'ProcessingComplete' },
      },
    ];
    const { licenses, entraGroup } = await groupLicenses(deps(graph), GROUP_SID);
    expect(licenses).toEqual({
      status: 'synced',
      licenses: [
        {
          skuId: CUSTOM,
          skuPartNumber: 'CONTOSO_PLAN',
          name: 'CONTOSO_PLAN',
          disabledPlanCount: 0,
        },
        { skuId: E3, skuPartNumber: 'SPE_E3', name: 'Microsoft 365 E3', disabledPlanCount: 1 },
      ],
      processingState: 'ProcessingComplete',
    });
    expect(entraGroup).toMatchObject({ entraGroupId: ENGINEERING.id, onPremisesSid: GROUP_SID });
  });

  it('says a group that isn’t in Entra yet is waiting for sync', async () => {
    const graph = new FakeGraph();
    graph.groups = [];
    expect(await groupLicenses(deps(graph), GROUP_SID)).toEqual({
      licenses: { status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' },
      entraGroup: null,
    });
  });
});

describe('licensedEntraGroups', () => {
  it('lists every group that grants a license, cloud-only ones included', async () => {
    const graph = new FakeGraph();
    graph.groups = [
      { ...ENGINEERING, assignedLicenses: [{ skuId: E3, disabledPlans: [] }] },
      { ...CLOUD, assignedLicenses: [{ skuId: VISIO }] },
    ];
    const groups = await licensedEntraGroups(deps(graph));
    // An advanced query: Graph refuses $count in a filter without both.
    const list = graph.gets.find((p) => p.includes('assignedLicenses/$count'))!;
    expect(list).toContain('$count=true');
    expect(graph.headers.get(list)).toEqual({ ConsistencyLevel: 'eventual' });
    expect(groups).toEqual([
      {
        entraGroupId: ENGINEERING.id,
        displayName: 'Engineering',
        onPremisesSid: GROUP_SID,
        skus: [{ skuId: E3, skuPartNumber: 'SPE_E3', disabledPlanCount: 0 }],
      },
      {
        entraGroupId: CLOUD.id,
        displayName: 'Cloud Licensing',
        onPremisesSid: null,
        skus: [{ skuId: VISIO, skuPartNumber: null, disabledPlanCount: 0 }],
      },
    ]);
  });
});
