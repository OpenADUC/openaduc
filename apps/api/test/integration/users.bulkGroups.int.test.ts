// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkGroupMembershipPreview, BulkGroupPreviewGroup } from '@openaduc/shared';
import {
  configureDirectory,
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
});
