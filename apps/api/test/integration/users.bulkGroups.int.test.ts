// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AuditBulkSummary,
  BulkGroupMembershipPreview,
  BulkGroupPreviewGroup,
  BulkJob,
  BulkJobRow,
} from '@openaduc/shared';
import {
  asAdministrator,
  configureDirectory,
  finishedJob,
  DC,
  readDirectoryUser,
  reseedDirectory,
  setGroupMember,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';
import { membershipPreviewToken } from '../../src/services/groupMembershipPreview.js';

type Fixture = 'alice' | 'bob' | 'carol' | 'dave' | 'guest';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  carol: 'carol.chen',
  dave: 'dave.diaz',
  // Outside the OU oa.operator may change; Domain Guests is its primary group.
  guest: 'Guest',
};

const ENGINEERING = 'CN=Engineering,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
const DOMAIN_GUESTS = 'CN=Domain Guests,CN=Users,DC=openaduc,DC=test';

interface AuditRow {
  action: string;
  result: string;
  targetId: string | null;
  bulkJobId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  bulk: AuditBulkSummary | null;
}

/** The group's `member` values, read from the DC as Administrator. */
const directoryMembers = (groupDn: string) =>
  asAdministrator(async (client) => {
    const { searchEntries } = await client.search(groupDn, {
      scope: 'base',
      filter: '(objectClass=group)',
      attributes: ['member'],
    });
    const member = searchEntries[0]?.member ?? [];
    return (Array.isArray(member) ? member : [member]).map((dn) => String(dn).toLowerCase());
  });

const dnOf = async (sam: string) =>
  String((await readDirectoryUser(sam, ['distinguishedName']))!.dn).toLowerCase();

describe('adding users to groups, or removing them, in bulk', () => {
  let api: TestApi;
  let operator: TestClient;
  let users: Record<Fixture, string>;
  let groups: Record<
    'engineering' | 'allStaff' | 'domainAdmins' | 'domainGuests' | 'domainUsers' | 'operators',
    string
  >;

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    const userId = async (sam: string) =>
      (await operator.get(`/api/users?q=${sam}`))
        .json<{ rows: { id: string; samAccountName: string }[] }>()
        .rows.find((r) => r.samAccountName.toLowerCase() === sam.toLowerCase())!.id;
    const groupId = async (name: string) =>
      (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
        .json<{ rows: { id: string; name: string }[] }>()
        .rows.find((g) => g.name === name)!.id;
    users = Object.fromEntries(
      await Promise.all(
        Object.entries(SAM).map(async ([key, sam]) => [key, await userId(sam)] as const),
      ),
    ) as Record<Fixture, string>;
    groups = {
      engineering: await groupId('Engineering'),
      allStaff: await groupId('All Staff'),
      domainAdmins: await groupId('Domain Admins'),
      domainGuests: await groupId('Domain Guests'),
      domainUsers: await groupId('Domain Users'),
      operators: await groupId('OpenADUC Operators'),
    };
  });

  afterAll(async () => {
    await api?.close();
    reseedDirectory();
  });

  async function preview(
    op: 'add' | 'remove',
    ids: string[],
    groupIds: string[],
    client = operator,
  ): Promise<BulkGroupMembershipPreview> {
    const res = await client.post('/api/users/bulk-groups/preview', { op, ids, groupIds });
    expect(res.statusCode).toBe(200);
    return res.json<BulkGroupMembershipPreview>();
  }

  // By fixture, not display name: other tests rename fixture accounts.
  const names = (list: { id: string }[]) =>
    list.map((u) => Object.entries(users).find(([, id]) => id === u.id)?.[0] ?? u.id);
  const summary = (g: BulkGroupPreviewGroup) => ({
    name: g.name,
    privilege: g.privilege,
    changes: g.changes,
    unchanged: names(g.unchanged.users),
    indirect: names(g.indirect.users),
  });

  describe('the preview', () => {
    it('counts who an add changes, lists who’s in already, and notes nested members', async () => {
      const missing = randomUUID();
      const result = await preview(
        'add',
        [users.alice, users.bob, users.carol, users.dave, missing],
        [groups.engineering, groups.allStaff, groups.domainAdmins, groups.operators],
      );

      expect(result.op).toBe('add');
      expect(result.unknownCount).toBe(1);
      expect(result.groups.map(summary)).toEqual([
        {
          name: 'Engineering',
          privilege: null,
          changes: 2,
          unchanged: ['alice', 'bob'],
          indirect: [],
        },
        {
          // Alice and Bob are in it through Engineering only.
          name: 'All Staff',
          privilege: null,
          changes: 3,
          unchanged: ['dave'],
          indirect: ['alice', 'bob'],
        },
        {
          name: 'Domain Admins',
          privilege: { reason: 'protected' },
          changes: 4,
          unchanged: [],
          indirect: [],
        },
        {
          name: 'OpenADUC Operators',
          privilege: { reason: 'role', role: 'operator' },
          changes: 4,
          unchanged: [],
          indirect: [],
        },
      ]);
    });

    it('counts who a remove changes, and notes who stays in through nesting', async () => {
      const result = await preview(
        'remove',
        [users.alice, users.bob, users.carol, users.dave],
        [groups.engineering, groups.allStaff],
      );

      expect(result.groups.map(summary)).toEqual([
        {
          name: 'Engineering',
          privilege: null,
          changes: 2,
          unchanged: ['carol', 'dave'],
          indirect: [],
        },
        {
          name: 'All Staff',
          privilege: null,
          changes: 1,
          unchanged: ['alice', 'bob', 'carol'],
          indirect: ['alice', 'bob'],
        },
      ]);
    });

    it('counts a primary group as a membership that can’t be added or removed', async () => {
      const ids = [users.alice, users.carol];

      const add = (await preview('add', ids, [groups.domainUsers])).groups[0]!;
      expect(summary(add)).toMatchObject({
        changes: 0,
        unchanged: ['alice', 'carol'],
        indirect: [],
      });
      const remove = (await preview('remove', ids, [groups.domainUsers])).groups[0]!;
      expect(summary(remove)).toMatchObject({
        changes: 0,
        unchanged: ['alice', 'carol'],
        indirect: ['alice', 'carol'],
      });
    });

    it('refuses a group the directory doesn’t have, and is a read anyone with read:user may make', async () => {
      const unknown = await operator.post('/api/users/bulk-groups/preview', {
        op: 'add',
        ids: [users.alice],
        groupIds: [randomUUID()],
      });
      expect(unknown.statusCode).toBe(404);

      const auditor = api.client();
      await auditor.signIn(api, 'oa.auditor');
      const read = await preview('add', [users.alice], [groups.engineering], auditor);
      expect(read.groups[0]!.unchanged).toEqual({
        count: 1,
        users: [expect.objectContaining({ id: users.alice })],
      });
      const nothingWritten = await api.app.db
        .selectFrom('audit_events')
        .select('action')
        .where('action', 'like', 'user.group.%')
        .execute();
      expect(nothingWritten).toEqual([]);
    });
  });

  describe('the job', () => {
    let auditor: TestClient;

    beforeAll(async () => {
      auditor = api.client();
      await auditor.signIn(api, 'oa.auditor');
    });

    const pathOf = (op: 'add' | 'remove') =>
      `/api/users/${op === 'add' ? 'bulk-add-to-groups' : 'bulk-remove-from-groups'}`;

    /** Preview, then start the job on what was previewed, as the UI does. */
    async function start(op: 'add' | 'remove', ids: string[], groupIds: string[]) {
      const { previewToken } = await preview(op, ids, groupIds);
      const res = await operator.post(pathOf(op), {
        ids,
        groupIds,
        previewToken,
        acknowledgeProtected: true,
      });
      expect(res.statusCode).toBe(202);
      return res.json<{ job: BulkJob }>().job;
    }

    const finished = (id: string) => finishedJob(operator, id);

    const rowsWith = async (id: string, status: BulkJobRow['status']) =>
      (await operator.get(`/api/bulk-jobs/${id}/rows?status=${status}`)).json<{
        rows: BulkJobRow[];
      }>().rows;

    const jobEvents = async (id: string) =>
      (await auditor.get(`/api/audit-events?bulkJobId=${id}&pageSize=200`))
        .json<{ rows: AuditRow[] }>()
        .rows.reverse();

    let addJob: string;
    const missingUser = randomUUID();

    it('adds each user to every group, and a partly done row names what it did and didn’t', async () => {
      const queued = await start(
        'add',
        [users.guest, users.carol, missingUser],
        [groups.engineering, groups.domainGuests],
      );
      addJob = queued.id;
      expect(queued).toMatchObject({
        action: 'user.group.add',
        subject: {
          groups: [
            { id: groups.engineering, name: 'Engineering', distinguishedName: ENGINEERING },
            { id: groups.domainGuests, name: 'Domain Guests', distinguishedName: DOMAIN_GUESTS },
          ],
        },
      });

      const job = await finished(queued.id);

      // Domain Guests is Guest's primary group already; Carol's add to it was refused.
      expect(job).toMatchObject({
        status: 'finished',
        counts: { total: 3, succeeded: 1, partial: 1, failed: 1, skipped: 0 },
      });
      const [guest, carol] = [await dnOf('Guest'), await dnOf('carol.chen')];
      expect(await directoryMembers(ENGINEERING)).toEqual(expect.arrayContaining([guest, carol]));
      expect(await directoryMembers(DOMAIN_GUESTS)).not.toContain(carol);
      const [partial] = await rowsWith(job.id, 'partial');
      expect(partial).toMatchObject({ targetId: users.carol, errorCode: 'permission_denied' });
      expect(partial!.errorMessage).toMatch(
        /^Added to Engineering\. Not added to Domain Guests: the directory refused the change/,
      );
      expect(await rowsWith(job.id, 'failed')).toEqual([
        expect.objectContaining({
          targetId: missingUser,
          errorCode: 'not_found',
          errorMessage: 'No such user in the directory.',
        }),
      ]);

      // The cache shows the adds straight away.
      const after = await preview('add', [users.guest, users.carol], [groups.engineering]);
      expect(names(after.groups[0]!.unchanged.users)).toEqual(['carol', 'guest']);
    });

    it('audits every user and group, changed or not, as the single-user route does', async () => {
      const events = await jobEvents(addJob);
      const carolDn = await dnOf('carol.chen');

      const [heading, ...rows] = events.map((e) => [
        e.action,
        e.result,
        e.targetId,
        e.metadata.groupName,
        e.before?.isMember ?? null,
      ]);
      expect(heading).toEqual(['bulk.create', 'success', null, undefined, null]);
      // Rows run a few at a time, so in no set order. Guest's Domain
      // Guests add is a no-op (its primary group), recorded with before
      // and after alike.
      expect(rows).toHaveLength(5);
      expect(rows).toEqual(
        expect.arrayContaining([
          ['user.group.add', 'success', users.guest, 'Engineering', false],
          ['user.group.add', 'success', users.guest, 'Domain Guests', true],
          ['user.group.add', 'success', users.carol, 'Engineering', false],
          ['user.group.add', 'failure', users.carol, 'Domain Guests', null],
          ['user.group.add', 'failure', missingUser, undefined, null],
        ]),
      );
      const carolAdd = events.find((e) => e.targetId === users.carol && e.result === 'success')!;
      expect(carolAdd).toMatchObject({
        metadata: { groupId: groups.engineering, groupDn: ENGINEERING, groupName: 'Engineering' },
        before: { isMember: false, group: ENGINEERING, memberKind: 'user' },
        after: { isMember: true, group: ENGINEERING, memberKind: 'user' },
      });
      expect(String(carolAdd.before!.member).toLowerCase()).toBe(carolDn);

      const grouped = (await auditor.get('/api/audit-events?groupBulk=1&pageSize=200')).json<{
        rows: AuditRow[];
      }>().rows;
      expect(grouped.filter((e) => e.bulkJobId === addJob)).toEqual([
        expect.objectContaining({
          action: 'bulk.create',
          bulk: expect.objectContaining({
            action: 'user.group.add',
            subject: {
              groups: [
                { id: groups.engineering, name: 'Engineering', distinguishedName: ENGINEERING },
                {
                  id: groups.domainGuests,
                  name: 'Domain Guests',
                  distinguishedName: DOMAIN_GUESTS,
                },
              ],
            },
            status: 'finished',
            total: 3,
            counts: expect.objectContaining({ succeeded: 1, partial: 1, failed: 1 }),
          }),
        }),
      ]);
    });

    it('retries the partial and failed rows, keeping what earlier runs changed', async () => {
      expect((await operator.post(`/api/bulk-jobs/${addJob}/retry`)).statusCode).toBe(200);
      const job = await finished(addJob);

      expect(job.counts).toMatchObject({ succeeded: 1, partial: 1, failed: 1 });
      const carol = (await jobEvents(addJob)).filter((e) => e.targetId === users.carol);
      expect(
        carol.map((e) => [e.result, e.metadata.groupName, e.before?.isMember ?? null]),
      ).toEqual(
        expect.arrayContaining([
          ['success', 'Engineering', false],
          ['success', 'Engineering', true],
          ['failure', 'Domain Guests', null],
        ]),
      );
      expect(carol).toHaveLength(4);
      const row = await api.app.db
        .selectFrom('bulk_job_rows')
        .select(['before_json', 'after_json'])
        .where('job_id', '=', addJob)
        .where('target_id', '=', users.carol)
        .executeTakeFirstOrThrow();
      expect(row.after_json).toEqual({
        groups: [{ id: groups.engineering, name: 'Engineering', isMember: true }],
      });
      expect(row.before_json).toEqual({
        groups: [{ id: groups.engineering, name: 'Engineering', isMember: false }],
      });
    });

    it('skips a user who needed no change, and still audits it', async () => {
      const job = await finished(
        (await start('add', [users.alice, users.carol], [groups.engineering, groups.domainUsers]))
          .id,
      );

      expect(job.counts).toMatchObject({ total: 2, succeeded: 0, skipped: 2 });
      const events = (await jobEvents(job.id)).filter((e) => e.action === 'user.group.add');
      expect(events).toHaveLength(4);
      expect(events.every((e) => e.result === 'success' && e.before?.isMember === true)).toBe(true);
      expect(events.filter((e) => e.before?.primaryGroup === true)).toHaveLength(2);
    });

    it('removes them again, and skips those not in the group', async () => {
      const job = await finished(
        (await start('remove', [users.guest, users.carol, users.dave], [groups.engineering])).id,
      );

      expect(job).toMatchObject({
        action: 'user.group.remove',
        counts: { succeeded: 2, skipped: 1, failed: 0 },
      });
      expect(await directoryMembers(ENGINEERING)).toEqual(
        expect.not.arrayContaining([await dnOf('Guest'), await dnOf('carol.chen')]),
      );
      const events = await jobEvents(job.id);
      expect(
        events.filter((e) => e.targetId === users.dave).map((e) => [e.result, e.before?.isMember]),
      ).toEqual([['success', false]]);
    });

    it('removes a member of a group renamed since the last sync', async () => {
      const renamed = ENGINEERING.replace('CN=Engineering', 'CN=Engineering Renamed');
      await asAdministrator((c) => c.modifyDN(ENGINEERING, renamed));
      try {
        const job = await finished((await start('remove', [users.bob], [groups.engineering])).id);

        expect(job.counts).toMatchObject({ succeeded: 1, skipped: 0 });
        expect(await directoryMembers(renamed)).not.toContain(await dnOf('bob.baker'));
        const [event] = (await jobEvents(job.id)).filter((e) => e.action === 'user.group.remove');
        expect(event).toMatchObject({ result: 'success', before: { isMember: true } });
      } finally {
        await asAdministrator((c) => c.modifyDN(renamed, ENGINEERING));
        await setGroupMember(ENGINEERING, 'bob.baker', true);
      }
    });

    it('takes the group-membership capability and a step-up, and groups the directory has', async () => {
      await auditor.stepUp();
      const body = { ids: [users.bob], groupIds: [groups.allStaff], previewToken: 'x' };
      expect((await auditor.post('/api/users/bulk-add-to-groups', body)).statusCode).toBe(403);

      const unelevated = api.client();
      await unelevated.signIn(api, 'oa.operator');
      const res = await unelevated.post('/api/users/bulk-remove-from-groups', body);
      expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });

      const before = (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>()
        .jobs.length;
      const gone = randomUUID();
      const unknown = await operator.post('/api/users/bulk-add-to-groups', {
        ids: [users.bob],
        groupIds: [gone],
        previewToken: membershipPreviewToken('add', [users.bob], [gone]),
      });
      expect(unknown.statusCode).toBe(404);
      expect(
        (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>().jobs,
      ).toHaveLength(before);
      const tooMany = await operator.post('/api/users/bulk-add-to-groups', {
        ids: [users.bob],
        groupIds: Array.from({ length: 21 }, () => randomUUID()),
        previewToken: 'x',
      });
      expect(tooMany.statusCode).toBe(400);
    });

    it('runs only on the users and groups previewed', async () => {
      const { previewToken: token } = await preview('add', [users.bob], [groups.allStaff]);
      const count = async () =>
        (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>().jobs.length;
      const before = await count();

      for (const body of [
        { ids: [users.bob, users.alice], groupIds: [groups.allStaff] },
        { ids: [users.bob], groupIds: [groups.allStaff, groups.engineering] },
      ]) {
        const res = await operator.post(pathOf('add'), { ...body, previewToken: token });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/Preview/) } });
      }
      // A remove isn't the add previewed either.
      const remove = await operator.post(pathOf('remove'), {
        ids: [users.bob],
        groupIds: [groups.allStaff],
        previewToken: token,
      });
      expect(remove.statusCode).toBe(409);
      expect(await count()).toBe(before);
    });

    it('takes an acknowledgement to add users to a group AD protects', async () => {
      const ids = [users.carol];
      const { previewToken: token } = await preview('add', ids, [groups.domainAdmins]);
      const before = (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>()
        .jobs.length;

      const res = await operator.post(pathOf('add'), {
        ids,
        groupIds: [groups.domainAdmins],
        previewToken: token,
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: { message: expect.stringMatching(/Domain Admins gives them admin rights in AD/) },
      });
      expect(
        (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>().jobs,
      ).toHaveLength(before);
    });

    it('takes configure:security to add members to a role group, in bulk or one at a time', async () => {
      const denials = () =>
        api.app.db
          .selectFrom('audit_events')
          .select(['metadata_json'])
          .where('action', '=', 'authz.deny')
          .orderBy('id')
          .execute();
      const already = (await denials()).length;
      const { previewToken: token } = await preview('add', [users.bob], [groups.operators]);

      const bulk = await operator.post(pathOf('add'), {
        ids: [users.bob],
        groupIds: [groups.operators],
        previewToken: token,
      });
      const single = await operator.post(`/api/users/${users.bob}/groups`, {
        groupId: groups.operators,
      });

      for (const res of [bulk, single]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({
          error: {
            message:
              'Adding members to OpenADUC Operators gives them OpenADUC’s Operator role, which takes the configure:security capability.',
          },
        });
      }
      const denied = (await denials()).slice(already);
      expect(denied.map((d) => d.metadata_json)).toEqual([
        expect.objectContaining({ requiredCapability: 'configure:security' }),
        expect.objectContaining({ requiredCapability: 'configure:security' }),
      ]);
      expect(await directoryMembers(DC.groups.operators)).not.toContain(await dnOf('bob.baker'));

      // An admin may; anyone with the membership capability may take members out.
      const admin = api.client();
      await admin.signIn(api, 'oa.admin');
      await admin.stepUp();
      expect(
        (await admin.post(`/api/users/${users.bob}/groups`, { groupId: groups.operators }))
          .statusCode,
      ).toBe(200);
      expect(
        (await operator.delete(`/api/users/${users.bob}/groups`, { groupId: groups.operators }))
          .statusCode,
      ).toBe(200);
    });
  });
});
