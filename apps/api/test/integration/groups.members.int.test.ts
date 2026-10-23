// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  setGroupMember,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const ALL_STAFF = 'CN=All Staff,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
const ENGINEERING = 'CN=Engineering,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
const DOMAIN_USERS = 'CN=Domain Users,CN=Users,DC=openaduc,DC=test';

interface Member {
  kind: 'user' | 'group';
  id: string;
  samAccountName: string | null;
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

describe('changing a group’s members from the group page', () => {
  let api: TestApi;
  let operator: TestClient;
  let allStaff: string;
  let engineering: string;
  let alice: string;

  const groupId = async (name: string) =>
    (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === name)!.id;
  const members = async (id: string) => {
    const res = await operator.get(`/api/groups/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ group: { memberCount: number; members: Member[] } }>().group;
  };
  const listedCount = async (name: string) =>
    (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
      .json<{ rows: { name: string; memberCount: number }[] }>()
      .rows.find((g) => g.name === name)!.memberCount;
  const auditRows = (action: string) =>
    api.app.db
      .selectFrom('audit_events')
      .select(['result', 'target_type', 'target_id', 'metadata_json', 'before_json', 'after_json'])
      .where('action', '=', action)
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    allStaff = await groupId('All Staff');
    engineering = await groupId('Engineering');
    alice = (await operator.get('/api/users?q=alice.anders')).json<{ rows: { id: string }[] }>()
      .rows[0]!.id;
  });

  afterAll(async () => {
    await api?.close();
    // reseedDirectory adds Engineering back to All Staff but removes nobody.
    await setGroupMember(ALL_STAFF, 'alice.anders', false);
    reseedDirectory();
  });

  it('lists groups nested in a group among its members', async () => {
    const group = await members(allStaff);

    expect(group.members).toContainEqual(
      expect.objectContaining({ kind: 'group', id: engineering, samAccountName: 'Engineering' }),
    );
    expect(group.members.map((m) => m.samAccountName).sort()).toEqual([
      'Engineering',
      'dave.diaz',
      'erin.evans',
    ]);
    expect(group.memberCount).toBe(3);
    expect(await listedCount('All Staff')).toBe(3);
  });

  it('adds a user with the user’s own membership change, and the group shows them at once', async () => {
    const res = await operator.post(`/api/users/${alice}/groups`, { groupId: allStaff });

    expect(res.statusCode).toBe(200);
    const aliceDn = String((await readDirectoryUser('alice.anders', ['distinguishedName']))!.dn);
    expect(await directoryMembers(ALL_STAFF)).toContain(aliceDn.toLowerCase());
    const group = await members(allStaff);
    expect(group.members).toContainEqual(expect.objectContaining({ kind: 'user', id: alice }));
    expect(group.memberCount).toBe(4);
    expect(await listedCount('All Staff')).toBe(4);
    expect(await auditRows('user.group.add')).toEqual([
      {
        result: 'success',
        target_type: 'user',
        target_id: alice,
        metadata_json: { groupId: allStaff, groupDn: ALL_STAFF, groupName: 'All Staff' },
        before_json: { isMember: false, group: ALL_STAFF, member: aliceDn, memberKind: 'user' },
        after_json: { isMember: true, group: ALL_STAFF, member: aliceDn, memberKind: 'user' },
      },
    ]);
  });

  it('removes a user, and the group drops them at once', async () => {
    const res = await operator.delete(`/api/users/${alice}/groups`, { groupId: allStaff });

    expect(res.statusCode).toBe(200);
    const group = await members(allStaff);
    expect(group.members.map((m) => m.id)).not.toContain(alice);
    expect(await listedCount('All Staff')).toBe(3);
    expect((await auditRows('user.group.remove')).map((r) => r.target_id)).toEqual([alice]);
  });

  it('takes a nested group out, audited like a user’s membership change', async () => {
    const res = await operator.delete(`/api/groups/${engineering}/groups`, { groupId: allStaff });

    expect(res.statusCode).toBe(200);
    expect(await directoryMembers(ALL_STAFF)).not.toContain(ENGINEERING.toLowerCase());
    const group = await members(allStaff);
    expect(group.members.map((m) => m.id)).not.toContain(engineering);
    expect(group.memberCount).toBe(2);
    expect(await listedCount('All Staff')).toBe(2);
    const snapshot = (isMember: boolean) => ({
      isMember,
      group: ALL_STAFF,
      member: ENGINEERING,
      memberKind: 'group',
    });
    expect(await auditRows('group.group.remove')).toEqual([
      {
        result: 'success',
        target_type: 'group',
        target_id: engineering,
        metadata_json: { groupId: allStaff, groupDn: ALL_STAFF, groupName: 'All Staff' },
        before_json: snapshot(true),
        after_json: snapshot(false),
      },
    ]);
  });

  it('nests a group in another, and the group shows it at once', async () => {
    const res = await operator.post(`/api/groups/${engineering}/groups`, { groupId: allStaff });

    expect(res.statusCode).toBe(200);
    expect(await directoryMembers(ALL_STAFF)).toContain(ENGINEERING.toLowerCase());
    const group = await members(allStaff);
    expect(group.members).toContainEqual(
      expect.objectContaining({ kind: 'group', id: engineering }),
    );
    expect(await listedCount('All Staff')).toBe(3);
    expect((await auditRows('group.group.add')).map((r) => [r.result, r.target_id])).toEqual([
      ['success', engineering],
    ]);
  });

  it('won’t make a group a member of itself', async () => {
    const res = await operator.post(`/api/groups/${allStaff}/groups`, {
      groupId: allStaff.toUpperCase(),
    });

    expect(res.statusCode).toBe(400);
    expect(await directoryMembers(ALL_STAFF)).not.toContain(ALL_STAFF.toLowerCase());
  });

  it('says why the directory refused a change, and audits the reason', async () => {
    // oa.operator has write rights only under OU=OpenADUC Test.
    const domainUsers = await groupId('Domain Users');

    const res = await operator.post(`/api/groups/${engineering}/groups`, {
      groupId: domainUsers,
    });

    expect(res.statusCode).toBe(403);
    const reason = res.json<{ error: { message: string } }>().error.message;
    expect(reason).toMatch(/^directory rejected the change: .+/);
    expect(await directoryMembers(DOMAIN_USERS)).not.toContain(ENGINEERING.toLowerCase());
    const [row] = (await auditRows('group.group.add')).filter((r) => r.result === 'failure');
    expect(row?.metadata_json).toEqual({
      groupId: domainUsers,
      groupDn: DOMAIN_USERS,
      groupName: 'Domain Users',
      errorMessage: reason.replace('directory rejected the change: ', ''),
    });
  });

  it('needs step-up to nest a group', async () => {
    const unelevated = api.client();
    await unelevated.signIn(api, 'oa.operator');

    const res = await unelevated.delete(`/api/groups/${engineering}/groups`, {
      groupId: allStaff,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    expect(await directoryMembers(ALL_STAFF)).toContain(ENGINEERING.toLowerCase());
  });

  it('refuses operators without the group-membership capability', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    const before = await auditRows('authz.deny');

    const nest = await auditor.delete(`/api/groups/${engineering}/groups`, { groupId: allStaff });
    const add = await auditor.post(`/api/users/${alice}/groups`, { groupId: allStaff });

    expect([nest.statusCode, add.statusCode]).toEqual([403, 403]);
    expect(await directoryMembers(ALL_STAFF)).toContain(ENGINEERING.toLowerCase());
    expect((await auditRows('authz.deny')).slice(before.length)).toEqual([
      expect.objectContaining({
        result: 'denied',
        metadata_json: {
          requiredCapability: 'write:group.membership',
          route: '/api/groups/:id/groups',
        },
      }),
      expect.objectContaining({
        result: 'denied',
        metadata_json: {
          requiredCapability: 'write:group.membership',
          route: '/api/users/:id/groups',
        },
      }),
    ]);
  });
});
