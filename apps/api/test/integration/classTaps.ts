// SPDX-License-Identifier: BUSL-1.1
import type {
  BulkJob,
  ClassRoster,
  ClassTapRequest,
  ImportRow,
  ImportRunRequest,
} from '@openaduc/shared';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { FakeTapGraph } from './fakeGraph.js';
import {
  DC,
  asAdministrator,
  configureDirectory,
  finishedJob,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

// Imports that issue Temporary Access Passes for class, against the dev
// DC, with Microsoft Graph played by one fake tenant for the whole file
// (its passes outlive each test). The follow-up's timer is stopped; tests
// sweep it by hand.

export const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
export const DOMAIN_ADMINS = 'CN=Domain Admins,CN=Users,DC=openaduc,DC=test';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The hour after `ms`, as an ISO instant. */
export const atHour = (ms: number) => new Date(Math.ceil(ms / HOUR) * HOUR).toISOString();
/** The UTC date `days` from now. */
export const day = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

export function row(sam: string, line: number, over: Partial<ImportRow> = {}): ImportRow {
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
    personalEmail: `${first.toLowerCase()}@example.com`,
    mobile: '+44 7700 900123',
    keepPhonesAsTyped: ['mobile'],
    ...over,
  };
}

/** Set up the file's API, directory, tenant and operator; delete `sams` before and after. */
export function useClassTaps(sams: readonly string[]) {
  const removeUsers = () =>
    asAdministrator(async (client) => {
      for (const sam of sams) {
        const { searchEntries } = await client.search(DC.baseDn, {
          scope: 'sub',
          filter: `(sAMAccountName=${sam})`,
          attributes: ['distinguishedName'],
        });
        for (const e of searchEntries) await client.del(e.dn).catch(() => undefined);
      }
    });

  let api: TestApi;
  let operator: TestClient;
  const graph = new FakeTapGraph();
  const ctx = {
    get api(): TestApi {
      return api;
    },
    get operator(): TestClient {
      return operator;
    },
    graph,
    classStart: atHour(Date.now() + 3 * DAY),

    classTap(over: Partial<ClassTapRequest> = {}): ClassTapRequest {
      return {
        start: { kind: 'fixed', startsAt: ctx.classStart },
        lifetimeMinutes: 240,
        isUsableOnce: false,
        ...over,
      };
    },
    request(rows: ImportRow[], tap: ClassTapRequest = ctx.classTap()): ImportRunRequest {
      return {
        import: {
          rows,
          password: { mode: 'random' },
          enabled: true,
          mailFromUpn: true,
          classTap: tap,
        },
      };
    },
    async runImport(rows: ImportRow[], tap?: ClassTapRequest): Promise<BulkJob> {
      const res = await operator.post('/api/users/import/run', ctx.request(rows, tap));
      expect(res.statusCode, res.body).toBe(202);
      return finishedJob(operator, res.json<{ job: BulkJob }>().job.id);
    },
    async roster(jobId: string, client = operator): Promise<ClassRoster> {
      const res = await client.get(`/api/users/import/jobs/${jobId}/class-roster`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<ClassRoster>();
    },
    async rosterRow(jobId: string, sam: string) {
      return (await ctx.roster(jobId)).rows.find((r) => r.samAccountName === sam)!;
    },
    rosterPath: (jobId: string, rest = '') => `/api/users/import/jobs/${jobId}/class-roster${rest}`,
    reveal: (client: TestClient, jobId: string, rowId: string) =>
      client.post(ctx.rosterPath(jobId, `/${rowId}/reveal`)),
    reissue: (client: TestClient, jobId: string, rowId: string) =>
      client.post(ctx.rosterPath(jobId, `/${rowId}/reissue`)),
    sweep: () => api.app.services.classPasses.sweep(5_000),
    /** Sweep with every waiting pass (and with `recheck`, every issued one) due now, however long its wait. */
    async sweepDue(recheck = false): Promise<void> {
      await api.app.db
        .updateTable('class_passes')
        .set({ next_attempt_at: sql`now()` })
        .where('status', 'in', recheck ? ['waiting', 'issued'] : ['waiting'])
        .execute();
      await ctx.sweep();
    },
    /** Forget what the follow-up last heard from Graph and AD, as a minute's or a quarter's wait would. */
    forgetReads(): void {
      const service = api.app.services.classPasses as unknown as Record<
        'liveStatus' | 'lastSync' | 'authority',
        Map<unknown, unknown>
      >;
      for (const cache of [service.liveStatus, service.lastSync, service.authority]) cache.clear();
    },
    async userId(sam: string): Promise<{ id: string; sid: string }> {
      const user = await api.app.db
        .selectFrom('user_cache_records')
        .select(['object_guid', 'sid'])
        .where('sam_account_name', '=', sam)
        .executeTakeFirstOrThrow();
      return { id: user.object_guid, sid: user.sid! };
    },
    /** Connect Sync brings `sam` to Entra. */
    async sync(sam: string): Promise<string> {
      graph.synced.set((await ctx.userId(sam)).sid, `entra-${sam}`);
      return `entra-${sam}`;
    },
    passOf: (sam: string) =>
      api.app.db
        .selectFrom('class_passes as p')
        .innerJoin('bulk_job_rows as r', 'r.id', 'p.row_id')
        .selectAll('p')
        .where(sql<string>`r.input_json->>'samAccountName'`, '=', sam)
        .orderBy('p.row_id', 'desc')
        .executeTakeFirstOrThrow(),
    audits: (action: string) =>
      api.app.db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', action)
        .orderBy('id')
        .execute(),
    setFeature: (on: boolean) =>
      api.app.services.entraIntegration.update(api.directoryId!, {
        features: { temporaryAccessPass: on },
      }),
  };

  beforeAll(async () => {
    await removeUsers();
    api = await startApi();
    await configureDirectory(ctx.api);
    await ctx.api.app.services.classPasses.stop();
    await ctx.api.app.services.entraIntegration.create(ctx.api.directoryId!, {
      tenantId: '11111111-2222-4333-8444-555555555555',
      clientId: 'client',
      clientSecret: 'not-a-real-secret',
      features: { temporaryAccessPass: true },
    });
    operator = ctx.api.client();
    await ctx.operator.signIn(ctx.api, 'oa.operator');
    await ctx.operator.stepUp();
  });
  beforeEach(() => {
    ctx.graph.requests = [];
    vi.stubGlobal('fetch', ctx.graph.fetch);
    ctx.api.app.services.graphClient.invalidateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await ctx.api?.close();
    await removeUsers();
  });

  return ctx;
}
