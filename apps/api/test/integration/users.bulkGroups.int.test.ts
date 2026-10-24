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
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

type Fixture = 'alice' | 'bob' | 'carol' | 'dave' | 'admin';
const SAM: Record<Fixture, string> = {
  alice: 'alice.anders',
  bob: 'bob.baker',
  carol: 'carol.chen',
  dave: 'dave.diaz',
  admin: 'oa.admin',
};

const ENGINEERING = 'CN=Engineering,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
const DOMAIN_ADMINS = 'CN=Domain Admins,CN=Users,DC=openaduc,DC=test';

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
    'engineering' | 'allStaff' | 'domainAdmins' | 'domainUsers' | 'operators',
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
    unchanged: names(g.unchanged),
    indirect: names(g.indirect),
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
      expect(result.unknownIds).toEqual([missing]);
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
      expect(names(read.groups[0]!.unchanged)).toEqual(['alice']);
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

    async function start(op: 'add' | 'remove', ids: string[], groupIds: string[]) {
      const path = op === 'add' ? 'bulk-add-to-groups' : 'bulk-remove-from-groups';
      const res = await operator.post(`/api/users/${path}`, { ids, groupIds });
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

    const failedRows = async (id: string) =>
      (await operator.get(`/api/bulk-jobs/${id}/rows?status=failed`)).json<{
        rows: BulkJobRow[];
      }>().rows;

    const jobEvents = async (id: string) =>
      (await auditor.get(`/api/audit-events?bulkJobId=${id}&pageSize=200`))
        .json<{ rows: AuditRow[] }>()
        .rows.reverse();

    let addJob: string;
    const missingUser = randomUUID();

    it('adds each user to every group, and a failed row names the group AD refused', async () => {
      const queued = await start(
        'add',
        [users.admin, users.carol, missingUser],
        [groups.engineering, groups.domainAdmins],
      );
      addJob = queued.id;
      expect(queued).toMatchObject({
        action: 'user.group.add',
        subject: {
          groups: [
            { id: groups.engineering, name: 'Engineering' },
            { id: groups.domainAdmins, name: 'Domain Admins' },
          ],
        },
      });

      const job = await finished(queued.id);

      // oa.admin is a Domain Admin already, so only Carol's add was refused.
      expect(job).toMatchObject({
        status: 'finished',
        counts: { total: 3, succeeded: 1, failed: 2 },
      });
      const [admin, carol] = [await dnOf('oa.admin'), await dnOf('carol.chen')];
      expect(await directoryMembers(ENGINEERING)).toEqual(expect.arrayContaining([admin, carol]));
      expect(await directoryMembers(DOMAIN_ADMINS)).not.toContain(carol);
      const failed = await failedRows(job.id);
      expect(failed.map((r) => [r.targetId, r.errorCode])).toEqual([
        [users.carol, 'permission_denied'],
        [missingUser, 'not_found'],
      ]);
      expect(failed[0]!.errorMessage).toMatch(
        /^Not added to Domain Admins: The directory refused the change/,
      );
      expect(failed[0]!.errorMessage).not.toContain('Engineering');
      expect(failed[1]!.errorMessage).toBe('No such user in the directory.');

      // The cache shows the adds straight away.
      const after = await preview('add', [users.admin, users.carol], [groups.engineering]);
      expect(names(after.groups[0]!.unchanged)).toEqual(['carol', 'admin']);
    });

    it('audits each change as the single-user route does, grouped under the job', async () => {
      const events = await jobEvents(addJob);
      const carolDn = await dnOf('carol.chen');

      const [heading, ...rows] = events.map((e) => [
        e.action,
        e.result,
        e.targetId,
        e.metadata.groupName,
      ]);
      expect(heading).toEqual(['bulk.create', 'success', null, undefined]);
      // Rows run a few at a time, so in no set order.
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(
        expect.arrayContaining([
          ['user.group.add', 'success', users.admin, 'Engineering'],
          ['user.group.add', 'success', users.carol, 'Engineering'],
          ['user.group.add', 'failure', users.carol, 'Domain Admins'],
          ['user.group.add', 'failure', missingUser, undefined],
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
          bulk: {
            action: 'user.group.add',
            subject: {
              groups: [
                { id: groups.engineering, name: 'Engineering' },
                { id: groups.domainAdmins, name: 'Domain Admins' },
              ],
            },
            status: 'finished',
            pauseReason: null,
            total: 3,
            counts: { total: 3, pending: 0, running: 0, succeeded: 1, failed: 2, skipped: 0 },
          },
        }),
      ]);
    });

    it('retries only the changes still missing', async () => {
      expect((await operator.post(`/api/bulk-jobs/${addJob}/retry`)).statusCode).toBe(200);
      const job = await finished(addJob);

      expect(job.counts).toMatchObject({ succeeded: 1, failed: 2 });
      const carol = (await jobEvents(addJob)).filter((e) => e.targetId === users.carol);
      expect(carol.map((e) => [e.result, e.metadata.groupName])).toEqual([
        ['success', 'Engineering'],
        ['failure', 'Domain Admins'],
        ['failure', 'Domain Admins'],
      ]);
    });

    it('removes them again, leaving alone those not in the group', async () => {
      const job = await finished(
        (await start('remove', [users.admin, users.carol, users.dave], [groups.engineering])).id,
      );

      expect(job).toMatchObject({ action: 'user.group.remove', counts: { succeeded: 3 } });
      expect(await directoryMembers(ENGINEERING)).toEqual(
        expect.not.arrayContaining([await dnOf('oa.admin'), await dnOf('carol.chen')]),
      );
      const events = await jobEvents(job.id);
      expect(events.map((e) => [e.action, e.targetId])).toEqual(
        expect.arrayContaining([
          ['user.group.remove', users.admin],
          ['user.group.remove', users.carol],
        ]),
      );
      // Dave wasn't in Engineering, so nothing was written for him.
      expect(events.filter((e) => e.targetId === users.dave)).toEqual([]);
    });

    it('takes the group-membership capability and a step-up, and groups the directory has', async () => {
      await auditor.stepUp();
      const body = { ids: [users.bob], groupIds: [groups.allStaff] };
      expect((await auditor.post('/api/users/bulk-add-to-groups', body)).statusCode).toBe(403);

      const unelevated = api.client();
      await unelevated.signIn(api, 'oa.operator');
      const res = await unelevated.post('/api/users/bulk-remove-from-groups', body);
      expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });

      const before = (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>()
        .jobs.length;
      const unknown = await operator.post('/api/users/bulk-add-to-groups', {
        ids: [users.bob],
        groupIds: [randomUUID()],
      });
      expect(unknown.statusCode).toBe(404);
      expect(
        (await operator.get('/api/bulk-jobs?limit=50')).json<{ jobs: BulkJob[] }>().jobs,
      ).toHaveLength(before);
      const tooMany = await operator.post('/api/users/bulk-add-to-groups', {
        ids: [users.bob],
        groupIds: Array.from({ length: 21 }, () => randomUUID()),
      });
      expect(tooMany.statusCode).toBe(400);
    });
  });
});
