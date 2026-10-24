// SPDX-License-Identifier: BUSL-1.1
// Imports and the licenses their groups grant, against the dev DC, with
// Microsoft Graph played by a fake behind fetch: the final check's seat
// and nesting warnings, the usage location written to AD when its schema
// has msExchUsageLocation, and the follow-up that reports each person's
// license errors once they've synced. The follow-up's timer is stopped;
// tests sweep it by hand.
import { sql } from 'kysely';
import type {
  BulkJob,
  BulkJobResultsDownload,
  ImportCheckResponse,
  ImportJobResponse,
  ImportRequest,
  ImportRow,
  ImportUsageLocation,
} from '@openaduc/shared';
import type { DirectoryProvider, UserCreateInput } from '../../src/providers/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceLicensedGroups } from '../../src/services/licenseCache.js';
import { json, token } from './fakeGraph.js';
import {
  DC,
  asAdministrator,
  configureDirectory,
  finishedJob,
  readDirectoryUser,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const NEW_SAMS = [
  'lia.lane',
  'max.mohr',
  'nia.nash',
  'oto.ortiz',
  'pia.park',
  'quin.quay',
  'rex.reed',
];

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

  /** Replace some of the provider's methods, given the real provider, for what runs next. */
  function tamper(make: (real: DirectoryProvider) => Partial<DirectoryProvider>) {
    const providers = api.app.services.providers;
    const original = providers.buildForDirectory.bind(providers);
    return vi.spyOn(providers, 'buildForDirectory').mockImplementation(async (id) => {
      const real = await original(id);
      const over = make(real) as Record<PropertyKey, unknown>;
      return new Proxy(real, {
        get(target, key) {
          if (key in over) return over[key];
          const value = Reflect.get(target, key) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    });
  }
  async function runImport(rows: ImportRow[]): Promise<BulkJob> {
    const res = await operator.post('/api/users/import/run', { import: request(rows) });
    expect(res.statusCode, res.body).toBe(202);
    return finishedJob(operator, res.json<{ job: BulkJob }>().job.id);
  }
  const view = async (id: string) => {
    const res = await operator.get(`/api/users/import/jobs/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportJobResponse>();
  };
  /** Sweep the follow-up with every waiting check due now, however long its wait. */
  const sweepDue = async () => {
    await api.app.db
      .updateTable('import_license_checks')
      .set({ next_attempt_at: sql`now()` })
      .where('status', '=', 'waiting')
      .execute();
    await api.app.services.importLicenses.sweep(5_000);
  };
  /** Connect Sync brings `sam` to Entra, holding these license states. */
  const sync = async (sam: string, states: FakeUser['licenseAssignmentStates']) => {
    const user = await api.app.db
      .selectFrom('user_cache_records')
      .select('sid')
      .where('sam_account_name', '=', sam)
      .executeTakeFirstOrThrow();
    graph.users.set(user.sid!, { id: `entra-${sam}`, licenseAssignmentStates: states });
  };
  const e3 = (state: string, error = 'None') => ({
    skuId: E3,
    assignedByGroup: 'entra-all-staff',
    state,
    error,
  });
  const rowOf = async (jobId: string, sam: string) =>
    (await view(jobId)).rows.find((r) => r.samAccountName === sam)!;
  const check = async (body: ImportRequest) => {
    const res = await operator.post('/api/users/import/check', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportCheckResponse>();
  };

  beforeAll(async () => {
    await removeNewUsers();
    api = await startApi();
    await configureDirectory(api);
    await api.app.services.importLicenses.stop();
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

  describe('usage location', () => {
    it('isn’t written where the schema lacks msExchUsageLocation, and the wizard is told', async () => {
      const res = await operator.get('/api/users/import/usage-location');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<ImportUsageLocation>()).toEqual({
        attribute: 'msExchUsageLocation',
        writable: false,
      });

      const job = await runImport([row('oto.ortiz', 2, [], { usageLocation: 'GB' })]);
      expect(job.counts.succeeded).toBe(1);
      const user = await readDirectoryUser('oto.ortiz', ['sAMAccountName', 'msExchUsageLocation']);
      expect(user?.sAMAccountName).toBe('oto.ortiz');
      expect(user?.msExchUsageLocation ?? []).toEqual([]);
    });

    it('is written with the account where the schema has it', async () => {
      const created: UserCreateInput[] = [];
      tamper((real) => ({
        hasSchemaAttribute: async (name: string) => name === 'msExchUsageLocation',
        // The dev DC's schema really lacks it: what's asked is kept, the rest made.
        createUser: async (...[input, ...rest]: Parameters<DirectoryProvider['createUser']>) => {
          created.push(input);
          return real.createUser({ ...input, usageLocation: null }, ...rest);
        },
      }));
      const res = await operator.get('/api/users/import/usage-location');
      expect(res.json<ImportUsageLocation>().writable).toBe(true);

      const job = await runImport([row('pia.park', 2, [], { usageLocation: 'de' })]);
      expect(job.counts.succeeded).toBe(1);
      expect(created).toEqual([expect.objectContaining({ usageLocation: 'DE' })]);
      const audit = await api.app.db
        .selectFrom('audit_events')
        .select('after_json')
        .where('bulk_job_id', '=', job.id)
        .where('action', '=', 'user.create')
        .executeTakeFirstOrThrow();
      expect(audit.after_json).toMatchObject({ usageLocation: 'DE' });
      expect((await view(job.id)).rows[0]?.status).toBe('succeeded');
    });
  });

  describe('the follow-up', () => {
    it('shows each person’s license errors once they sync, on the page and in the CSV', async () => {
      const allStaff = groups['All Staff']!.id;
      const job = await runImport([
        row('lia.lane', 2, [allStaff]),
        row('max.mohr', 3, [allStaff]),
        row('quin.quay', 4, []),
      ]);
      expect(job.counts.succeeded).toBe(3);
      expect((await rowOf(job.id, 'quin.quay')).licenses).toBeNull();
      expect((await rowOf(job.id, 'lia.lane')).licenses).toEqual({
        status: 'waiting',
        message: 'Waiting for the account to sync.',
        licenses: [
          {
            skuId: E3,
            skuPartNumber: 'SPE_E3',
            name: 'Microsoft 365 E3',
            group: 'All Staff',
            state: 'pending',
            error: null,
          },
        ],
        checkedAt: null,
      });

      // Not in Entra yet: it waits for Connect Sync.
      await sweepDue();
      expect((await rowOf(job.id, 'lia.lane')).licenses).toMatchObject({
        status: 'waiting',
        message: 'Waiting for Connect Sync to bring them to Microsoft Entra.',
      });

      await sync('lia.lane', [e3('Error', 'CountViolation')]);
      await sync('max.mohr', [e3('Active')]);
      await sweepDue();
      const lia = (await rowOf(job.id, 'lia.lane')).licenses!;
      expect(lia).toMatchObject({ status: 'settled', message: null });
      expect(lia.licenses).toEqual([
        expect.objectContaining({
          name: 'Microsoft 365 E3',
          state: 'error',
          error: 'CountViolation',
        }),
      ]);
      expect(lia.checkedAt).not.toBeNull();
      expect((await rowOf(job.id, 'max.mohr')).licenses?.licenses).toEqual([
        expect.objectContaining({ state: 'active', error: null }),
      ]);

      // Settled checks aren't looked at again.
      graph.requests = [];
      await sweepDue();
      expect(graph.requests).toEqual([]);

      const res = await operator.post(`/api/bulk-jobs/${job.id}/results`);
      expect(res.statusCode, res.body).toBe(200);
      const lines = res.json<BulkJobResultsDownload>().csv.trim().split('\r\n');
      expect(lines[0]).toBe('Row,Status,Display name,Username,UPN,Problems,Licenses');
      expect(lines[1]).toContain(
        'Microsoft 365 E3: Not enough licenses: every one the tenant has of this product is assigned.',
      );
      expect(lines[2]).toMatch(/,Microsoft 365 E3: assigned$/);
      expect(lines[3]).toMatch(/,,$/);
    });

    it('waits for group-based licensing to settle, within a window', async () => {
      const job = await runImport([row('nia.nash', 2, [groups['All Staff']!.id])]);
      await sync('nia.nash', []);
      await sweepDue();
      expect((await rowOf(job.id, 'nia.nash')).licenses).toMatchObject({
        status: 'waiting',
        message: 'Waiting for Entra to assign Microsoft 365 E3.',
        licenses: [expect.objectContaining({ state: 'pending' })],
      });
      const check = await api.app.db
        .selectFrom('import_license_checks')
        .select(['next_attempt_at', 'synced_at'])
        .where('job_id', '=', job.id)
        .executeTakeFirstOrThrow();
      // The first look after their sync comes a minute on.
      expect(new Date(check.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(50_000);
      expect(new Date(check.next_attempt_at).getTime() - Date.now()).toBeLessThan(70_000);

      // Graph throttling holds the directory's checks back.
      graph.throttled.set('/users/entra-nia.nash', 60);
      await sweepDue();
      expect((await rowOf(job.id, 'nia.nash')).licenses?.message).toBe(
        'Microsoft Graph is busy: their licenses are read again shortly.',
      );
      graph.throttled.clear();
      graph.requests = [];
      await sweepDue();
      expect(graph.requests).toEqual([]);
      (
        api.app.services.importLicenses as unknown as { throttledUntil: Map<number, number> }
      ).throttledUntil.clear();

      // Past two hours since they synced, it stops waiting and says so.
      await api.app.db
        .updateTable('import_license_checks')
        .set({ synced_at: sql`now() - interval '3 hours'` })
        .where('job_id', '=', job.id)
        .execute();
      await sweepDue();
      expect((await rowOf(job.id, 'nia.nash')).licenses).toMatchObject({
        status: 'timedOut',
        message:
          'Entra still hadn’t assigned Microsoft 365 E3 two hours after they synced. Their Licenses tab shows how it stands now.',
      });
    });

    it('leaves no check while licenses are off', async () => {
      await api.app.services.entraIntegration.update(api.directoryId!, {
        features: { licenses: false },
      });
      try {
        const job = await runImport([row('rex.reed', 2, [groups['All Staff']!.id])]);
        expect((await rowOf(job.id, 'rex.reed')).licenses).toBeNull();
      } finally {
        await api.app.services.entraIntegration.update(api.directoryId!, {
          features: { licenses: true },
        });
      }
    });
  });
});
