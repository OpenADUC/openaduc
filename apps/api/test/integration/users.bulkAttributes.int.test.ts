// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AuditBulkSummary,
  BulkAttributeChanges,
  BulkJob,
  BulkJobRow,
  BulkUserAttributesPreview,
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

type Fixture = 'alice' | 'bob' | 'dave' | 'erin' | 'admin';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  dave: 'dave.diaz',
  erin: 'erin.evans',
  // In CN=Users, outside the OU oa.operator may change.
  admin: 'Administrator',
};
const ATTRIBUTES = [
  'title',
  'department',
  'company',
  'physicalDeliveryOfficeName',
  'manager',
  'l',
  'c',
  'co',
  'countryCode',
] as const;

interface AuditRow {
  action: string;
  result: string;
  targetId: string | null;
  errorCode: string | null;
  bulkJobId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  bulk: AuditBulkSummary | null;
}

/** Replace (or, with no values, delete) attributes on a user, as Administrator. */
async function setAttributes(sam: string, values: Record<string, string[]>): Promise<void> {
  const dn = String((await readDirectoryUser(sam, ['distinguishedName']))!.dn);
  const { Attribute, Change } = await import('ldapts');
  await asAdministrator((client) =>
    client.modify(
      dn,
      Object.entries(values).map(
        ([type, vals]) =>
          new Change({
            operation: vals.length ? 'replace' : 'delete',
            modification: new Attribute({ type, values: vals }),
          }),
      ),
    ),
  ).catch((err: Error) => {
    // Deleting an attribute the user doesn't have.
    if (err.name !== 'NoSuchAttributeError') throw err;
  });
}

const valuesOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [String(v)]);

/** The attributes, as the DC has them; an absent one is []. */
async function directoryValues(sam: string): Promise<Record<string, string[]>> {
  const entry = (await readDirectoryUser(sam, [...ATTRIBUTES]))!;
  return Object.fromEntries(ATTRIBUTES.map((a) => [a, valuesOf(entry[a])]));
}

describe('editing users’ attributes in bulk', () => {
  let api: TestApi;
  let operator: TestClient;
  let auditor: TestClient;
  let users: Record<Fixture, string>;
  const original = new Map<string, Record<string, string[]>>();

  beforeAll(async () => {
    reseedDirectory();
    for (const sam of Object.values(SAM)) original.set(sam, await directoryValues(sam));
    // A known start: Alice in Engineering, Bob and Dave in Sales, all at Initech.
    await setAttributes(SAM.alice, { department: ['Engineering'], company: ['Initech'] });
    await setAttributes(SAM.bob, { department: ['Sales'], company: ['Initech'] });
    await setAttributes(SAM.dave, { department: ['Sales'], company: ['Initech'] });
    for (const sam of [SAM.alice, SAM.bob, SAM.dave, SAM.admin]) {
      await setAttributes(sam, { physicalDeliveryOfficeName: [], manager: [], l: [] });
    }

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
    for (const [sam, values] of original) {
      const { countryCode, ...rest } = values;
      await setAttributes(sam, {
        ...rest,
        countryCode: countryCode!.length ? countryCode! : ['0'],
      });
    }
  });

  async function preview(
    ids: string[],
    changes: BulkAttributeChanges = {},
    client = operator,
  ): Promise<BulkUserAttributesPreview> {
    const res = await client.post('/api/users/bulk-update/preview', { ids, changes });
    expect(res.statusCode).toBe(200);
    return res.json<BulkUserAttributesPreview>();
  }

  // By fixture, not display name: other tests rename fixture accounts.
  const nameOf = (id: string) => Object.entries(users).find(([, u]) => u === id)?.[0] ?? id;

  describe('the preview', () => {
    it('says which fields the users share a value in, and which hold several', async () => {
      const { current } = await preview([users.alice, users.bob, users.dave]);

      expect(current).toMatchObject({
        department: { kind: 'multiple', count: 2 },
        company: { kind: 'same', value: 'Initech' },
        physicalDeliveryOfficeName: { kind: 'same', value: null },
        manager: { kind: 'same', value: null },
        country: { kind: 'same', value: null },
      });
    });

    it('lists every user’s before and after for each field it changes, and who’s as asked', async () => {
      const result = await preview([users.alice, users.bob, users.dave, randomUUID()], {
        department: 'Sales',
        company: null,
        physicalDeliveryOfficeName: 'Leeds',
        manager: users.erin,
        country: 'gb',
      });

      expect(result.unknownCount).toBe(1);
      expect(result.fields).toEqual([
        { field: 'department', count: 1 },
        { field: 'company', count: 3 },
        { field: 'physicalDeliveryOfficeName', count: 3 },
        { field: 'manager', count: 3 },
        { field: 'country', count: 3 },
      ]);
      expect(result.changed.count).toBe(3);
      const alice = result.changed.users.find((u) => u.id === users.alice)!;
      expect(alice.changes).toEqual([
        { field: 'department', before: 'Engineering', after: 'Sales' },
        { field: 'company', before: 'Initech', after: null },
        { field: 'physicalDeliveryOfficeName', before: null, after: 'Leeds' },
        { field: 'manager', before: null, after: expect.stringMatching(/Erin|erin/) },
        { field: 'country', before: null, after: 'United Kingdom' },
      ]);
      const bob = result.changed.users.find((u) => u.id === users.bob)!;
      expect(bob.changes.map((c) => c.field)).not.toContain('department');

      const asked = await preview([users.bob, users.dave], { department: 'Sales' });
      expect(asked.changed).toEqual({ count: 0, users: [] });
      expect(asked.unchanged.users.map((u) => nameOf(u.id))).toEqual(['bob', 'dave']);
    });

    it('refuses a manager the directory doesn’t have, or one of the users edited', async () => {
      const unknown = await operator.post('/api/users/bulk-update/preview', {
        ids: [users.alice],
        changes: { manager: randomUUID() },
      });
      expect(unknown.statusCode).toBe(404);

      const self = await operator.post('/api/users/bulk-update/preview', {
        ids: [users.alice, users.erin],
        changes: { manager: users.erin },
      });
      expect(self.statusCode).toBe(422);
      expect(self.json()).toMatchObject({
        error: { message: expect.stringMatching(/their own manager/) },
      });
    });

    it('is a read anyone with read:user may make, and writes nothing', async () => {
      const read = await preview([users.alice], { department: 'Sales' }, auditor);
      expect(read.changed.count).toBe(1);
      const written = await api.app.db
        .selectFrom('audit_events')
        .select('action')
        .where('action', '=', 'user.update')
        .execute();
      expect(written).toEqual([]);
    });
  });

  describe('the job', () => {
    const PATH = '/api/users/bulk-update';

    async function start(ids: string[], changes: BulkAttributeChanges) {
      const { previewToken } = await preview(ids, changes);
      const res = await operator.post(PATH, { ids, changes, previewToken });
      expect(res.statusCode).toBe(202);
      return res.json<{ job: BulkJob }>().job;
    }

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

    const rowsWith = async (id: string, status: BulkJobRow['status']) =>
      (await operator.get(`/api/bulk-jobs/${id}/rows?status=${status}`)).json<{
        rows: BulkJobRow[];
      }>().rows;

    const jobEvents = async (id: string) =>
      (await auditor.get(`/api/audit-events?bulkJobId=${id}&pageSize=200`))
        .json<{ rows: AuditRow[] }>()
        .rows.reverse();

    const jobCount = async () =>
      (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>().jobs.length;

    let setJob: string;
    const missing = randomUUID();

    it('sets and clears each field, and fails the users the operator may not change', async () => {
      const changes: BulkAttributeChanges = {
        department: 'Sales',
        company: null,
        physicalDeliveryOfficeName: 'Leeds',
        manager: users.erin,
        country: 'GB',
      };
      const queued = await start(
        [users.alice, users.bob, users.dave, users.admin, missing],
        changes,
      );
      setJob = queued.id;
      expect(queued).toMatchObject({
        action: 'user.update',
        subject: {
          attributes: [
            { field: 'department', value: 'Sales' },
            { field: 'company', value: null },
            { field: 'physicalDeliveryOfficeName', value: 'Leeds' },
            { field: 'manager', value: expect.any(String) },
            { field: 'country', value: 'United Kingdom' },
          ],
        },
      });

      const job = await finished(queued.id);

      expect(job).toMatchObject({
        status: 'finished',
        counts: { total: 5, succeeded: 3, failed: 2, skipped: 0 },
      });
      const erinDn = String((await readDirectoryUser(SAM.erin, ['distinguishedName']))!.dn);
      for (const sam of [SAM.alice, SAM.bob, SAM.dave]) {
        expect(await directoryValues(sam)).toMatchObject({
          department: ['Sales'],
          company: [],
          physicalDeliveryOfficeName: ['Leeds'],
          manager: [erinDn],
          c: ['GB'],
          co: ['United Kingdom'],
          countryCode: ['826'],
        });
      }
      expect(await directoryValues(SAM.admin)).toMatchObject({ department: [], c: [] });
      expect(
        (await rowsWith(job.id, 'failed')).map((r) => [nameOf(r.targetId), r.errorCode]),
      ).toEqual(
        expect.arrayContaining([
          ['admin', 'permission_denied'],
          [missing, 'not_found'],
        ]),
      );

      // The cache shows the edit straight away.
      const after = await preview([users.alice, users.bob, users.dave], changes);
      expect(after.changed.count).toBe(0);
      expect(after.current.department).toEqual({ kind: 'same', value: 'Sales' });
    });

    it('audits each user as the single-user edit does, grouped under the job', async () => {
      const events = await jobEvents(setJob);

      const [heading, ...rows] = events;
      expect(heading).toMatchObject({ action: 'bulk.create', result: 'success' });
      expect(rows.map((e) => [e.action, e.result, nameOf(e.targetId!)])).toEqual(
        expect.arrayContaining([
          ['user.update', 'success', 'alice'],
          ['user.update', 'success', 'bob'],
          ['user.update', 'success', 'dave'],
          ['user.update', 'failure', 'admin'],
          ['user.update', 'failure', missing],
        ]),
      );
      expect(rows).toHaveLength(5);
      const alice = rows.find((e) => e.targetId === users.alice)!;
      expect(alice).toMatchObject({
        metadata: {
          fields: expect.arrayContaining(['department', 'company', 'managerDn', 'c', 'co']),
        },
        before: { department: 'Engineering', company: 'Initech', c: null },
        after: { department: 'Sales', company: null, c: 'GB', countryCode: '826' },
      });
      expect(rows.find((e) => e.targetId === users.admin)).toMatchObject({
        errorCode: 'permission_denied',
      });

      const row = await api.app.db
        .selectFrom('bulk_job_rows')
        .select(['before_json', 'after_json'])
        .where('job_id', '=', setJob)
        .where('target_id', '=', users.bob)
        .executeTakeFirstOrThrow();
      expect(row.before_json).toMatchObject({
        company: 'Initech',
        physicalDeliveryOfficeName: null,
      });
      expect(row.after_json).toMatchObject({ company: null, physicalDeliveryOfficeName: 'Leeds' });
      expect(row.before_json).not.toHaveProperty('department');

      const grouped = (await auditor.get('/api/audit-events?groupBulk=1&pageSize=200')).json<{
        rows: AuditRow[];
      }>().rows;
      expect(grouped.filter((e) => e.bulkJobId === setJob)).toEqual([
        expect.objectContaining({
          action: 'bulk.create',
          bulk: expect.objectContaining({
            action: 'user.update',
            subject: expect.objectContaining({ attributes: expect.any(Array) }),
            status: 'finished',
            total: 5,
            counts: expect.objectContaining({ succeeded: 3, failed: 2 }),
          }),
        }),
      ]);
    });

    it('skips users already as asked, writing nothing for them', async () => {
      const job = await finished(
        (await start([users.alice, users.bob], { department: 'Sales', company: null })).id,
      );

      expect(job.counts).toMatchObject({ total: 2, succeeded: 0, skipped: 2 });
      const events = (await jobEvents(job.id)).filter((e) => e.action === 'user.update');
      expect(events).toEqual([]);
    });

    it('writes only the fields a user isn’t already as asked in', async () => {
      await setAttributes(SAM.bob, { l: ['York'] });
      await operator.get(`/api/users/${users.bob}`);
      const job = await finished(
        (await start([users.alice, users.bob], { department: 'Sales', l: 'York' })).id,
      );

      expect(job.counts).toMatchObject({ succeeded: 1, skipped: 1 });
      const [event] = (await jobEvents(job.id)).filter((e) => e.action === 'user.update');
      expect(event).toMatchObject({ targetId: users.alice, metadata: { fields: ['l'] } });
      expect((await directoryValues(SAM.alice)).l).toEqual(['York']);
    });

    it('clears the manager and the country', async () => {
      const job = await finished(
        (await start([users.alice, users.bob], { manager: null, country: null })).id,
      );

      expect(job.counts).toMatchObject({ succeeded: 2 });
      for (const sam of [SAM.alice, SAM.bob]) {
        expect(await directoryValues(sam)).toMatchObject({
          manager: [],
          c: [],
          co: [],
          countryCode: ['0'],
        });
      }
    });

    it('refuses a manager among the users edited', async () => {
      const before = await jobCount();
      const changes = { manager: users.alice };
      const ids = [users.alice, users.bob];
      const res = await operator.post(PATH, { ids, changes, previewToken: 'x' });
      // The token is checked first; a matching one still can't make Alice her own manager.
      expect(res.statusCode).toBe(409);
      const { attributesPreviewToken } = await import('../../src/services/bulkAttributes.js');
      const self = await operator.post(PATH, {
        ids,
        changes,
        previewToken: attributesPreviewToken(ids, changes),
      });
      expect(self.statusCode).toBe(422);
      expect(await jobCount()).toBe(before);
    });

    it('runs only on the users and changes previewed', async () => {
      const { previewToken } = await preview([users.bob], { department: 'Marketing' });
      const before = await jobCount();

      for (const body of [
        { ids: [users.bob, users.alice], changes: { department: 'Marketing' } },
        { ids: [users.bob], changes: { department: 'Finance' } },
        { ids: [users.bob], changes: { department: 'Marketing', company: null } },
      ]) {
        const res = await operator.post(PATH, { ...body, previewToken });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/Preview/) } });
      }
      expect(await jobCount()).toBe(before);
      expect((await directoryValues(SAM.bob)).department).toEqual(['Sales']);
    });

    it('takes the attribute-write capability and a step-up', async () => {
      const ids = [users.bob];
      const changes = { department: 'Marketing' };
      const { previewToken } = await preview(ids, changes);

      await auditor.stepUp();
      expect((await auditor.post(PATH, { ids, changes, previewToken })).statusCode).toBe(403);

      const unelevated = api.client();
      await unelevated.signIn(api, 'oa.operator');
      const res = await unelevated.post(PATH, { ids, changes, previewToken });
      expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });

      const empty = await operator.post(PATH, { ids, changes: {}, previewToken });
      expect(empty.statusCode).toBe(400);
    });
  });
});
