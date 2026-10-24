// SPDX-License-Identifier: BUSL-1.1
// Reassigning a departing manager's direct reports: the manager's page
// lists them, and the operator moves some to a new manager with the bulk
// attribute edit's preview and job, setting only the manager.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AuditBulkSummary,
  BulkJob,
  BulkUserAttributesPreview,
  UserDetail,
} from '@openaduc/shared';
import {
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

type Fixture = 'alice' | 'bob' | 'carol' | 'dave' | 'erin';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  // Disabled.
  carol: 'carol.chen',
  dave: 'dave.diaz',
  erin: 'erin.evans',
};
const REPORTS = ['alice', 'bob', 'carol'] as const;

interface AuditRow {
  action: string;
  result: string;
  targetId: string | null;
  bulkJobId: string | null;
  metadata: Record<string, unknown>;
  bulk: AuditBulkSummary | null;
}

const dnOf = async (sam: string) =>
  String((await readDirectoryUser(sam, ['distinguishedName']))!.dn);

/** Set (or, with null, clear) a user's manager, as Administrator. */
async function setManager(sam: string, managerDn: string | null): Promise<void> {
  const dn = await dnOf(sam);
  const { Attribute, Change } = await import('ldapts');
  await asAdministrator(async (client) => {
    await client
      .modify(
        dn,
        new Change({
          operation: managerDn ? 'replace' : 'delete',
          modification: new Attribute({ type: 'manager', values: managerDn ? [managerDn] : [] }),
        }),
      )
      .catch((err: Error) => {
        if (err.name !== 'NoSuchAttributeError') throw err;
      });
  });
}

const managerOf = async (sam: string) =>
  ((await readDirectoryUser(sam, ['manager']))!.manager as string | undefined) ?? null;

describe('reassigning a manager’s direct reports', () => {
  let api: TestApi;
  let operator: TestClient;
  let auditor: TestClient;
  let users: Record<Fixture, string>;
  let erinDn: string;
  let daveDn: string;

  beforeAll(async () => {
    reseedDirectory();
    erinDn = await dnOf(SAM.erin);
    daveDn = await dnOf(SAM.dave);
    for (const report of REPORTS) await setManager(SAM[report], erinDn);
    await setManager(SAM.dave, null);

    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    const userId = async (sam: string) =>
      (await operator.get(`/api/users?q=${sam}`))
        .json<{ rows: { id: string; samAccountName: string }[] }>()
        .rows.find((r) => r.samAccountName.toLowerCase() === sam.toLowerCase())!.id;
    users = Object.fromEntries(
      await Promise.all(
        Object.entries(SAM).map(async ([key, sam]) => [key, await userId(sam)] as const),
      ),
    ) as Record<Fixture, string>;
  });

  afterAll(async () => {
    await api?.close();
    for (const report of REPORTS) await setManager(SAM[report], null);
  });

  // By fixture, not display name: other tests rename fixture accounts.
  const nameOf = (id: string | null) => Object.entries(users).find(([, u]) => u === id)?.[0];

  const reportsOf = async (who: Fixture) =>
    (await operator.get(`/api/users/${users[who]}`))
      .json<{ user: UserDetail }>()
      .user.directReports.map((r) => [nameOf(r.id), r.enabled])
      .sort();

  async function finished(id: string): Promise<BulkJob> {
    for (let i = 0; i < 300; i++) {
      const { job } = (await operator.get(`/api/bulk-jobs/${id}`)).json<{ job: BulkJob }>();
      if (job.status !== 'queued' && job.status !== 'running' && job.counts.pending === 0) {
        return job;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`bulk job ${id} didn’t finish`);
  }

  it('lists the manager’s direct reports, saying which are disabled', async () => {
    expect(await reportsOf('erin')).toEqual([
      ['alice', true],
      ['bob', true],
      ['carol', false],
    ]);
  });

  it('moves only the selected reports to the new manager, as one bulk job', async () => {
    const ids = [users.alice, users.carol];
    const changes = { manager: users.dave };
    const res = await operator.post('/api/users/bulk-update/preview', { ids, changes });
    expect(res.statusCode).toBe(200);
    const preview = res.json<BulkUserAttributesPreview>();
    expect(preview.changed.count).toBe(2);
    for (const user of preview.changed.users) {
      expect(user.changes).toEqual([
        {
          field: 'manager',
          before: expect.stringMatching(/erin/i),
          after: expect.stringMatching(/dave/i),
        },
      ]);
    }

    const started = await operator.post('/api/users/bulk-update', {
      ids,
      changes,
      previewToken: preview.previewToken,
    });
    expect(started.statusCode).toBe(202);
    const job = await finished(started.json<{ job: BulkJob }>().job.id);

    expect(job).toMatchObject({
      action: 'user.update',
      status: 'finished',
      counts: { total: 2, succeeded: 2, failed: 0, skipped: 0 },
    });
    expect(await managerOf(SAM.alice)).toBe(daveDn);
    expect(await managerOf(SAM.carol)).toBe(daveDn);
    expect(await managerOf(SAM.bob)).toBe(erinDn);
    expect(await reportsOf('erin')).toEqual([['bob', true]]);
    expect(await reportsOf('dave')).toEqual([
      ['alice', true],
      ['carol', false],
    ]);

    const events = (await auditor.get(`/api/audit-events?bulkJobId=${job.id}&pageSize=200`)).json<{
      rows: AuditRow[];
    }>().rows;
    expect(
      events
        .filter((e) => e.action === 'user.update')
        .map((e) => [nameOf(e.targetId), e.result, e.metadata.fields])
        .sort(),
    ).toEqual([
      ['alice', 'success', ['managerDn']],
      ['carol', 'success', ['managerDn']],
    ]);
    const grouped = (await auditor.get('/api/audit-events?groupBulk=1&pageSize=200')).json<{
      rows: AuditRow[];
    }>().rows;
    expect(grouped.filter((e) => e.bulkJobId === job.id)).toEqual([
      expect.objectContaining({
        action: 'bulk.create',
        bulk: expect.objectContaining({
          action: 'user.update',
          subject: { attributes: [{ field: 'manager', value: expect.stringMatching(/dave/i) }] },
          total: 2,
          counts: expect.objectContaining({ succeeded: 2, failed: 0 }),
        }),
      }),
    ]);
  });
});
