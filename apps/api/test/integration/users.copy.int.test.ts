// SPDX-License-Identifier: BUSL-1.1
import type { UserCopySource, UserCreateRequest, UserCreateResponse } from '@openaduc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DC,
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  setGroupMember,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const ALICE_DN = `CN=Alice Anders,${STAFF_OU}`;
const BOB_DN = `CN=Bob Baker,${STAFF_OU}`;
const ENGINEERING_DN = 'CN=Engineering,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
// Outside OU=OpenADUC Test, so oa.operator can't change its members, and
// flagged the way AdminSDHolder flags an administrative group.
const ADMINS_DN = 'CN=Copy Test Admins,CN=Users,DC=openaduc,DC=test';
const NEW_SAMS = ['vera.vance', 'walt.west', 'xena.xu', 'yara.york', 'zane.zhu'];

// What Alice has that a copy takes, and what it doesn't.
const ALICE_ORGANISATION: Record<string, string> = {
  company: 'OpenADUC Ltd',
  physicalDeliveryOfficeName: 'Leeds',
  streetAddress: '1 Park Row\r\nFloor 2',
  l: 'Leeds',
  postalCode: 'LS1 5AB',
  c: 'GB',
  co: 'United Kingdom',
  countryCode: '826',
  manager: BOB_DN,
};
const ALICE_OWN: Record<string, string> = {
  description: 'Template for engineers',
  employeeID: 'E-1001',
  telephoneNumber: '+44 113 496 0000',
  mobile: '+44 7700 900123',
};

function person(sam: string, over: Partial<UserCreateRequest> = {}): UserCreateRequest {
  const [first, last] = sam.split('.').map((p) => p[0]!.toUpperCase() + p.slice(1)) as [
    string,
    string,
  ];
  return {
    ouDn: STAFF_OU,
    givenName: first,
    surname: last,
    displayName: `${first} ${last}`,
    cn: `${first} ${last}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@${DC.domain}`,
    mailFromUpn: true,
    password: { mode: 'random' },
    enabled: true,
    ...over,
  };
}

const UAC_DISABLED = 0x2;
const ATTRS = [
  'userAccountControl',
  'memberOf',
  'description',
  'employeeID',
  'telephoneNumber',
  'mobile',
  'title',
  'department',
  ...Object.keys(ALICE_ORGANISATION),
];
const directoryUser = (sam: string) => readDirectoryUser(sam, ATTRS);
const memberOf = (entry: Record<string, unknown> | null) =>
  [entry?.memberOf ?? []].flat().map((dn) => String(dn).toLowerCase());

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

/** Give Alice, or take back, what a template user has besides her fixture's. */
async function setAlice(set: boolean): Promise<void> {
  for (const [attribute, value] of Object.entries({ ...ALICE_ORGANISATION, ...ALICE_OWN })) {
    // AD won't delete countryCode; 0 is its "no country".
    const unset = attribute === 'countryCode' ? ['0'] : [];
    await setUserAttribute('alice.anders', attribute, set ? [value] : unset);
  }
}

describe('copying a user', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let alice: string;
  let copy: UserCopySource;

  const auditRows = (action: string) =>
    api.app.db
      .selectFrom('audit_events')
      .select([
        'result',
        'target_id',
        'correlation_id',
        'metadata_json',
        'after_json',
        'error_code',
      ])
      .where('action', '=', action)
      .orderBy('id')
      .execute();
  const groupIds = () => {
    const id = (dn: string) =>
      copy.groups.find((g) => g.distinguishedName.toLowerCase() === dn.toLowerCase())!.id;
    return { engineering: id(ENGINEERING_DN), admins: id(ADMINS_DN) };
  };
  /** Alice's copy as the create form sends it, for someone new. */
  const copyOfAlice = (sam: string, groups: string[]): UserCreateRequest =>
    person(sam, {
      organisation: {
        ...copy.organisation,
        managerId: copy.manager?.id ?? null,
      },
      groups,
      copiedFrom: alice,
    });
  const dropGroupMembership = () =>
    api.app.db
      .updateTable('admin_sessions')
      .set({
        capabilities_json: JSON.stringify(['read:user', 'read:group', 'write:user.create']),
      })
      .where('actor_username', '=', `oa.operator@${DC.domain}`)
      .where('revoked_at', 'is', null)
      .execute();

  beforeAll(async () => {
    await removeNewUsers();
    await asAdministrator(async (client) => {
      await client.del(ADMINS_DN).catch(() => undefined);
      await client.add(ADMINS_DN, {
        objectClass: ['top', 'group'],
        cn: 'Copy Test Admins',
        sAMAccountName: 'Copy Test Admins',
        adminCount: '1',
      });
    });
    await setGroupMember(ADMINS_DN, 'alice.anders', true);
    await setGroupMember(DC.groups.auditors, 'alice.anders', true);
    await setAlice(true);
    api = await startApi();
    admin = await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    alice = (await operator.get('/api/users?q=alice.anders')).json<{ rows: { id: string }[] }>()
      .rows[0]!.id;
  });

  afterAll(async () => {
    await api?.close();
    await removeNewUsers();
    await setAlice(false);
    await setGroupMember(DC.groups.auditors, 'alice.anders', false);
    await asAdministrator((client) => client.del(ADMINS_DN).catch(() => undefined));
  });

  it('offers the source’s OU, organisation and direct groups, and none of its own details', async () => {
    const res = await operator.get(`/api/users/${alice}/copy`);

    expect(res.statusCode, res.body).toBe(200);
    copy = res.json<UserCopySource>();
    expect(copy.source).toEqual({
      id: alice,
      distinguishedName: ALICE_DN,
      samAccountName: 'alice.anders',
      displayName: expect.any(String),
    });
    expect(copy.ouDn).toBe(STAFF_OU);
    expect(copy.organisation).toEqual({
      title: 'Engineer',
      department: 'Engineering',
      company: 'OpenADUC Ltd',
      physicalDeliveryOfficeName: 'Leeds',
      streetAddress: '1 Park Row\r\nFloor 2',
      l: 'Leeds',
      st: null,
      postalCode: 'LS1 5AB',
      c: 'GB',
      co: 'United Kingdom',
      countryCode: '826',
    });
    expect(copy.manager).toMatchObject({ distinguishedName: BOB_DN, displayName: 'Bob Baker' });
    // Direct groups only: not All Staff (through Engineering), nor Domain
    // Users (her primary group); administrative ones flagged.
    expect(
      copy.groups
        .map((g) => [g.name, g.privilege])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['Copy Test Admins', { reason: 'protected' }],
      ['Engineering', null],
      ['OpenADUC Auditors', { reason: 'role', role: 'auditor' }],
    ]);
    for (const value of Object.values(ALICE_OWN)) expect(res.body).not.toContain(value);
    expect((await auditRows('user.view')).at(-1)).toMatchObject({ target_id: alice });
  });

  it('is only for those who may create users', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    expect((await auditor.get(`/api/users/${alice}/copy`)).statusCode).toBe(403);
  });

  it('is a 404 for a user that isn’t there', async () => {
    const res = await operator.get('/api/users/00000000-0000-4000-8000-000000000000/copy');
    expect(res.statusCode).toBe(404);
  });

  it('needs group membership rights to add the copy to groups', async () => {
    await dropGroupMembership();

    const res = await operator.post('/api/users', copyOfAlice('xena.xu', [groupIds().engineering]));

    expect(res.statusCode).toBe(403);
    expect(await directoryUser('xena.xu')).toBeNull();
    expect((await auditRows('authz.deny')).at(-1)?.metadata_json).toEqual({
      requiredCapability: 'write:group.membership',
      route: '/api/users',
    });
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
  });

  it('refuses a group, manager or source it doesn’t know, and writes nothing', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    const responses = await Promise.all([
      operator.post('/api/users', copyOfAlice('xena.xu', [unknown])),
      operator.post('/api/users', {
        ...copyOfAlice('xena.xu', []),
        organisation: { managerId: unknown },
      }),
      operator.post('/api/users', { ...copyOfAlice('xena.xu', []), copiedFrom: unknown }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([400, 400, 400]);
    expect(await directoryUser('xena.xu')).toBeNull();
  });

  describe('a copy with a group the operator can’t add it to', () => {
    let created: UserCreateResponse;

    it('writes the organisation and the groups it can, and leaves the account disabled', async () => {
      const { engineering, admins } = groupIds();

      const res = await operator.post(
        '/api/users',
        copyOfAlice('vera.vance', [engineering, admins]),
      );

      expect(res.statusCode, res.body).toBe(200);
      created = res.json<UserCreateResponse>();
      expect(created).toMatchObject({
        completed: ['create', 'password'],
        remaining: ['groups', 'enable'],
        failure: { step: 'groups', message: expect.stringContaining('Copy Test Admins') },
      });
      const entry = await directoryUser('vera.vance');
      expect(entry).toMatchObject({
        title: 'Engineer',
        department: 'Engineering',
        ...ALICE_ORGANISATION,
      });
      for (const attribute of Object.keys(ALICE_OWN)) expect(entry?.[attribute]).toEqual([]);
      expect(memberOf(entry)).toEqual([ENGINEERING_DN.toLowerCase()]);
      expect(Number(entry?.userAccountControl) & UAC_DISABLED).not.toBe(0);
    });

    it('audits the create and each group add as one operation, linked to the source', async () => {
      const { engineering, admins } = groupIds();
      const [create] = await auditRows('user.create');

      expect(create).toMatchObject({
        result: 'failure',
        target_id: created.id,
        metadata_json: expect.objectContaining({
          copiedFrom: { id: alice, distinguishedName: ALICE_DN, samAccountName: 'alice.anders' },
          groups: [
            { id: engineering, distinguishedName: ENGINEERING_DN, name: 'Engineering' },
            { id: admins, distinguishedName: ADMINS_DN, name: 'Copy Test Admins' },
          ],
        }),
        after_json: expect.objectContaining({
          completed: ['create', 'password'],
          remaining: ['groups', 'enable'],
          groupsLeft: [admins],
          organisation: expect.objectContaining({ department: 'Engineering', manager: BOB_DN }),
        }),
      });
      const adds = await auditRows('user.group.add');
      expect(adds).toEqual([
        expect.objectContaining({
          result: 'success',
          target_id: created.id,
          correlation_id: create!.correlation_id,
          metadata_json: expect.objectContaining({
            groupId: engineering,
            groupName: 'Engineering',
          }),
        }),
        expect.objectContaining({
          result: 'failure',
          error_code: 'permission_denied',
          target_id: created.id,
          correlation_id: create!.correlation_id,
          metadata_json: expect.objectContaining({ groupId: admins }),
        }),
      ]);
      expect(await auditRows('user.copied')).toEqual([
        expect.objectContaining({
          result: 'success',
          target_id: alice,
          correlation_id: create!.correlation_id,
          metadata_json: {
            copyId: created.id,
            copyDn: `CN=Vera Vance,${STAFF_OU}`,
            copySamAccountName: 'vera.vance',
          },
        }),
      ]);
    });

    it('needs group membership rights to retry the group', async () => {
      await dropGroupMembership();

      const res = await operator.post(`/api/users/${created.id}/finish-create`, { enabled: true });

      expect(res.statusCode).toBe(403);
      await operator.signIn(api, 'oa.operator');
      await operator.stepUp();
    });

    it('lets someone with the rights finish it: the group that failed, then enabling', async () => {
      const { admins } = groupIds();

      const res = await admin.post(`/api/users/${created.id}/finish-create`, { enabled: true });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<UserCreateResponse>()).toMatchObject({
        completed: ['create', 'password', 'groups', 'enable'],
        remaining: [],
        failure: null,
      });
      const entry = await directoryUser('vera.vance');
      expect(memberOf(entry).sort()).toEqual(
        [ADMINS_DN.toLowerCase(), ENGINEERING_DN.toLowerCase()].sort(),
      );
      expect(Number(entry?.userAccountControl) & UAC_DISABLED).toBe(0);
      const finish = (await auditRows('user.create.finish')).at(-1);
      expect(finish).toMatchObject({
        result: 'success',
        metadata_json: expect.objectContaining({ steps: ['groups', 'enable'] }),
      });
      expect((await auditRows('user.group.add')).at(-1)).toMatchObject({
        result: 'success',
        target_id: created.id,
        correlation_id: finish!.correlation_id,
        metadata_json: expect.objectContaining({ groupId: admins }),
      });
    });
  });

  it('copies in one call when every group goes in, and enables the account', async () => {
    const { engineering } = groupIds();

    const res = await operator.post('/api/users', copyOfAlice('walt.west', [engineering]));

    expect(res.statusCode, res.body).toBe(200);
    const created = res.json<UserCreateResponse>();
    expect(created).toMatchObject({
      completed: ['create', 'password', 'groups', 'enable'],
      remaining: [],
      failure: null,
    });
    const entry = await directoryUser('walt.west');
    expect(entry).toMatchObject({ department: 'Engineering', ...ALICE_ORGANISATION });
    expect(entry?.userAccountControl).toBe('512');
    expect(memberOf(entry)).toEqual([ENGINEERING_DN.toLowerCase()]);
    const create = (await auditRows('user.create')).at(-1)!;
    expect(create).toMatchObject({
      result: 'success',
      target_id: created.id,
      metadata_json: expect.objectContaining({
        copiedFrom: expect.objectContaining({ id: alice }),
      }),
    });
    expect((await auditRows('user.group.add')).at(-1)).toMatchObject({
      result: 'success',
      target_id: created.id,
      correlation_id: create.correlation_id,
    });
    expect((await auditRows('user.copied')).at(-1)).toMatchObject({
      target_id: alice,
      correlation_id: create.correlation_id,
      metadata_json: expect.objectContaining({ copyId: created.id }),
    });
    const groups = (await operator.get(`/api/users/${created.id}`)).json<{
      user: { groupMemberships: { id: string; direct: boolean }[] };
    }>().user.groupMemberships;
    expect(groups).toContainEqual(expect.objectContaining({ id: engineering, direct: true }));
  });

  describe('a group still to add that no longer exists', () => {
    const unfinished = async (sam: string) => {
      const { engineering, admins } = groupIds();
      const res = await operator.post('/api/users', copyOfAlice(sam, [engineering, admins]));
      const created = res.json<UserCreateResponse>();
      expect(created.remaining).toEqual(['groups', 'enable']);
      return created.id!;
    };
    const finish = (id: string) =>
      operator.post(`/api/users/${id}/finish-create`, { enabled: true });
    const setAdminsDeletedInCache = (deleted: boolean) =>
      api.app.db
        .updateTable('group_cache_records')
        .set({ deleted_at: deleted ? new Date().toISOString() : null })
        .where('object_guid', '=', groupIds().admins)
        .execute();

    it('is left out once the cache has seen it go, and the rest finishes', async () => {
      const { admins } = groupIds();
      const id = await unfinished('yara.york');
      await setAdminsDeletedInCache(true);

      const res = await finish(id);
      await setAdminsDeletedInCache(false);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<UserCreateResponse>()).toMatchObject({
        completed: ['create', 'password', 'groups', 'enable'],
        remaining: [],
        groupsSkipped: [admins],
      });
      expect((await directoryUser('yara.york'))?.userAccountControl).toBe('512');
      expect((await auditRows('user.create.finish')).at(-1)).toMatchObject({
        result: 'success',
        target_id: id,
        after_json: expect.objectContaining({ groupsSkipped: [admins] }),
      });
    });

    it('is left out when the directory no longer has it, though the cache still does', async () => {
      const { admins } = groupIds();
      const id = await unfinished('zane.zhu');
      await asAdministrator((client) => client.del(ADMINS_DN));

      const res = await finish(id);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<UserCreateResponse>()).toMatchObject({
        remaining: [],
        groupsSkipped: [admins],
      });
      expect((await directoryUser('zane.zhu'))?.userAccountControl).toBe('512');
    });
  });
});
