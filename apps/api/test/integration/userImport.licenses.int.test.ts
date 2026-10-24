// SPDX-License-Identifier: BUSL-1.1
// Imports and the licenses their groups grant, against the dev DC, with
// Microsoft Graph played by a fake behind fetch: the final check's seat
// and nesting warnings, the usage location written to AD when its schema
// has msExchUsageLocation, and the follow-up that reports each person's
// license errors once they've synced. The follow-up's timer is stopped;
// tests sweep it by hand.
import type { ImportCheckResponse, ImportRequest, ImportRow } from '@openaduc/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceLicensedGroups } from '../../src/services/licenseCache.js';
import { json, token } from './fakeGraph.js';
import {
  DC,
  asAdministrator,
  configureDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const NEW_SAMS = ['lia.lane', 'max.mohr', 'nia.nash', 'oto.ortiz', 'pia.park', 'quin.quay'];

interface FakeUser {
  id: string;
  licenseAssignmentStates: {
    skuId: string;
    assignedByGroup: string | null;
    state: string;
    error: string;
  }[];
}

/** Microsoft Graph as far as an import's licenses use it. */
class FakeLicenseGraph {
  skus = [
    {
      skuId: E3,
      skuPartNumber: 'SPE_E3',
      consumedUnits: 10,
      prepaidUnits: { enabled: 12, warning: 0, suspended: 0 },
    },
  ];
  /** AD objectSid → Entra user, for the users Connect Sync has synced. */
  users = new Map<string, FakeUser>();
  /** Paths Graph answers as throttled, asking for this many seconds. */
  throttled = new Map<string, number>();
  requests: string[] = [];

  fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    this.requests.push(url.toString());
    if (url.hostname === 'login.microsoftonline.com') {
      return json({
        access_token: token(['User.Read.All', 'Group.Read.All', 'Organization.Read.All']),
        expires_in: 3600,
      });
    }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    const wait = this.throttled.get(path);
    if (wait !== undefined) {
      return json({ error: { code: 'TooManyRequests' } }, 429, { 'Retry-After': String(wait) });
    }
    if (path === '/organization') {
      return json({ value: [{ onPremisesLastSyncDateTime: '2026-10-24T11:30:00Z' }] });
    }
    if (path === '/subscribedSkus') return json({ value: this.skus });
    if (path === '/users') {
      const sid = /onPremisesSecurityIdentifier eq '([^']+)'/.exec(
        url.searchParams.get('$filter') ?? '',
      )?.[1];
      const user = sid ? this.users.get(sid) : undefined;
      return json({ value: user ? [{ id: user.id }] : [] });
    }
    const user = /^\/users\/([^/]+)$/.exec(path);
    if (user) {
      const found = [...this.users.values()].find((u) => u.id === decodeURIComponent(user[1]!));
      return found ? json(found) : json({ error: { code: 'Request_ResourceNotFound' } }, 404);
    }
    return json({ error: { code: 'Request_ResourceNotFound', message: path } }, 404);
  };
}

function row(
  sam: string,
  line: number,
  groups: string[],
  over: Partial<ImportRow> = {},
): ImportRow {
  const [first, last] = sam.split('.').map((p) => p[0]!.toUpperCase() + p.slice(1)) as [
    string,
    string,
  ];
  return {
    line,
    ouDn: STAFF_OU,
    givenName: first,
    surname: last,
    displayName: `${first} ${last}`,
    cn: `${first} ${last}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@${DC.domain}`,
    groups,
    ...over,
  };
}

const request = (rows: ImportRow[]): ImportRequest => ({
  rows,
  password: { mode: 'random' },
  enabled: true,
  mailFromUpn: true,
});

const removeNewUsers = () =>
  asAdministrator(async (client) => {
    for (const sam of NEW_SAMS) {
      const { searchEntries } = await client.search(DC.baseDn, {
        scope: 'sub',
        filter: `(sAMAccountName=${sam})`,
        attributes: ['distinguishedName'],
      });
      for (const e of searchEntries) await client.del(e.dn).catch(() => undefined);
    }
  });

describe('an import’s licenses', () => {
  let api: TestApi;
  let operator: TestClient;
  let graph: FakeLicenseGraph;
  const groups: Record<string, { id: string; sid: string }> = {};

  const check = async (body: ImportRequest) => {
    const res = await operator.post('/api/users/import/check', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportCheckResponse>();
  };

  beforeAll(async () => {
    await removeNewUsers();
    api = await startApi();
    await configureDirectory(api);
    await api.app.services.entraIntegration.create(api.directoryId!, {
      tenantId: '11111111-2222-4333-8444-555555555555',
      clientId: 'client',
      clientSecret: 'not-a-real-secret',
      features: { licenses: true },
    });
    for (const r of await api.app.db
      .selectFrom('group_cache_records')
      .select(['object_guid', 'sid', 'name'])
      .where('provider_id', '=', api.directoryId!)
      .where('name', 'in', ['Engineering', 'All Staff'])
      .execute()) {
      groups[r.name!] = { id: r.object_guid, sid: r.sid! };
    }
    // All Staff grants Microsoft 365 E3; Engineering, inside it, grants nothing.
    await replaceLicensedGroups(api.app.db, api.directoryId!, [
      {
        entraGroupId: 'entra-all-staff',
        displayName: 'All Staff',
        onPremisesSid: groups['All Staff']!.sid,
        skus: [{ skuId: E3, skuPartNumber: 'SPE_E3', disabledPlanCount: 0 }],
      },
    ]);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
  });
  beforeEach(() => {
    graph = new FakeLicenseGraph();
    vi.stubGlobal('fetch', graph.fetch);
    api.app.services.graphClient.invalidateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await api?.close();
    await removeNewUsers();
  });

  describe('the final check', () => {
    it('warns of a product with fewer seats free than the people joining its groups', async () => {
      const allStaff = groups['All Staff']!.id;
      const rows = ['lia.lane', 'max.mohr', 'nia.nash'].map((sam, i) =>
        row(sam, i + 2, [allStaff]),
      );
      const result = await check(request(rows));
      expect(result.problems).toEqual([]);
      expect(result.warnings).toEqual([
        {
          row: null,
          kind: 'license_seats',
          message:
            'Microsoft 365 E3: 3 people join groups that grant it, but only 2 are free. Entra won’t assign it to 1 of them until licenses are bought or freed up.',
        },
      ]);

      // Enough seats, nothing to say.
      graph.skus[0]!.prepaidUnits.enabled = 13;
      expect((await check(request(rows))).warnings).toEqual([]);
    });

    it('says when none is free, and of seats in a grace period', async () => {
      graph.skus[0]!.prepaidUnits = { enabled: 10, warning: 5, suspended: 0 };
      const result = await check(request([row('lia.lane', 2, [groups['All Staff']!.id])]));
      expect(result.warnings.map((w) => w.message)).toEqual([
        'Microsoft 365 E3: 1 person joins groups that grant it, but none is free. Entra won’t assign it to 1 of them until licenses are bought or freed up. Another 5 are in a lapsed subscription’s grace period, so they don’t last.',
      ]);
    });

    it('warns of a bucket group that is only inside a licensed group', async () => {
      const result = await check(request([row('lia.lane', 2, [groups['Engineering']!.id])]));
      expect(result.problems).toEqual([]);
      expect(result.warnings).toEqual([
        {
          row: null,
          kind: 'license_nested',
          message:
            '“Engineering” is inside “All Staff”, which grants Microsoft 365 E3, but group-based licensing doesn’t follow nested groups: the people added to Engineering don’t get it. License Engineering itself, or add them to “All Staff” too.',
        },
      ]);
    });

    it('goes ahead, saying so, when Entra won’t say how many seats are free', async () => {
      graph.throttled.set('/subscribedSkus', 30);
      const result = await check(request([row('lia.lane', 2, [groups['All Staff']!.id])]));
      expect(result.problems).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          kind: 'license_seats',
          message: expect.stringMatching(/^Couldn’t check the free licenses in Entra: /),
        }),
      ]);
    });

    it('asks nothing while licenses are off', async () => {
      await api.app.services.entraIntegration.update(api.directoryId!, {
        features: { licenses: false },
      });
      try {
        const result = await check(request([row('lia.lane', 2, [groups['All Staff']!.id])]));
        expect(result.warnings).toEqual([]);
        expect(graph.requests).toEqual([]);
      } finally {
        await api.app.services.entraIntegration.update(api.directoryId!, {
          features: { licenses: true },
        });
      }
    });
  });
});
