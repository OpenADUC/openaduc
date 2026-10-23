// SPDX-License-Identifier: BUSL-1.1
import { Attribute, Change } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DC,
  asAdministrator,
  configureDirectory,
  reseedDirectory,
  sambaTool,
  setGroupMember,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const GROUPS_OU = 'OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test';
const STAFF_OU = 'OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test';
const ALL_STAFF = `CN=All Staff,${GROUPS_OU}`;
const ENGINEERING = `CN=Engineering,${GROUPS_OU}`;
const CREATED = `CN=Project Falcon,${GROUPS_OU}`;
const DISTRIBUTION = `CN=Falcon Mail,${GROUPS_OU}`;
const PROTECTED = `CN=Tier Zero,${GROUPS_OU}`;
const NESTED = `CN=Tier Nested,${GROUPS_OU}`;
const PRIMARY = `CN=Primary Home,${GROUPS_OU}`;
const PRIMARY_USER = `CN=prim.test,${STAFF_OU}`;
const DOMAIN_ADMINS = 'CN=Domain Admins,CN=Users,DC=openaduc,DC=test';

const newGroup = {
  parentDn: GROUPS_OU,
  name: 'Project Falcon',
  samAccountName: 'project.falcon',
  description: 'Falcon project team',
  scope: 'global',
  type: 'security',
} as const;

/** A group straight from the DC, or null. */
const directoryGroup = (dn: string) =>
  asAdministrator(async (client) => {
    try {
      const { searchEntries } = await client.search(dn, {
        scope: 'base',
        filter: '(objectClass=group)',
        attributes: ['groupType', 'sAMAccountName', 'description'],
      });
      return searchEntries[0] ?? null;
    } catch {
      return null;
    }
  });

const removeTestGroups = () =>
  asAdministrator(async (client) => {
    for (const dn of [PRIMARY_USER, CREATED, DISTRIBUTION, PROTECTED, NESTED, PRIMARY])
      await client.del(dn).catch(() => undefined);
  });

describe('creating and deleting groups', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let auditor: TestClient;

  const groupId = async (name: string) =>
    (await admin.get(`/api/groups?q=${encodeURIComponent(name)}`))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === name)?.id;
  const auditRows = (action: string) =>
    api.app.db
      .selectFrom('audit_events')
      .select(['result', 'target_type', 'target_id', 'target_dn', 'metadata_json', 'before_json'])
      .where('action', '=', action)
      .orderBy('id')
      .execute();
  const nameCheck = (params: Record<string, string>) =>
    operator.get(`/api/groups/name-check?${new URLSearchParams(params).toString()}`);

  beforeAll(async () => {
    reseedDirectory();
    await removeTestGroups();
    api = await startApi();
    admin = await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
  });

  afterAll(async () => {
    await api?.close();
    await removeTestGroups();
    reseedDirectory();
  });

  describe('name check', () => {
    it('says which object holds a name in the OU, or a pre-Windows 2000 name anywhere', async () => {
      const res = await nameCheck({
        parentDn: GROUPS_OU,
        name: 'engineering',
        samAccountName: 'alice.anders',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        nameTaken: true,
        samAccountNameTaken: true,
        nameTakenBy: ENGINEERING,
        samAccountNameTakenBy: `CN=Alice Anders,${STAFF_OU}`,
      });
    });

    it('finds free names free, and a name taken only in another OU free here', async () => {
      const res = await nameCheck({
        parentDn: STAFF_OU,
        name: 'Engineering',
        samAccountName: 'project.falcon',
      });

      expect(res.json()).toEqual({
        nameTaken: false,
        samAccountNameTaken: false,
        nameTakenBy: null,
        samAccountNameTakenBy: null,
      });
    });

    it('says a name is taken outside the base DN without saying by what', async () => {
      const scoped = await admin.post('/api/directories', {
        name: 'Test OU only',
        domain: DC.domain,
        baseDn: 'OU=OpenADUC Test,DC=openaduc,DC=test',
        ldapUrls: [DC.ldapsUrl],
        tlsMode: 'ldaps',
        adminUsername: 'oa.admin',
        adminPassword: DC.password,
      });
      expect(scoped.statusCode).toBeLessThan(300);
      const scopedId = scoped.json<{ directory: { id: number } }>().directory.id;
      const bind = await admin.patch(`/api/directories/${scopedId}`, {
        syncBindUpn: `${DC.serviceAccount}@${DC.domain}`,
        syncBindPassword: DC.password,
      });
      expect(bind.statusCode).toBeLessThan(300);
      await api.app.services.sync.runOnce(scopedId, 'ous.full');
      const scopedOperator = api.client();
      await scopedOperator.signInTo(scopedId, 'oa.operator');

      const res = await scopedOperator.get(
        `/api/groups/name-check?${new URLSearchParams({
          parentDn: GROUPS_OU,
          name: 'Engineering',
          samAccountName: 'Administrator',
        }).toString()}`,
      );

      expect(res.json()).toEqual({
        nameTaken: true,
        samAccountNameTaken: true,
        nameTakenBy: ENGINEERING,
        samAccountNameTakenBy: null,
      });
    });

    it('refuses an OU OpenADUC doesn’t know', async () => {
      const res = await nameCheck({ parentDn: 'OU=Nowhere,DC=openaduc,DC=test', name: 'x' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('create', () => {
    it('creates a global security group, audits it, and lists it at once', async () => {
      const res = await operator.post('/api/groups', newGroup);

      expect(res.statusCode).toBe(200);
      const { group } = res.json<{ group: { id: string; distinguishedName: string } }>();
      expect(group).toMatchObject({
        distinguishedName: CREATED,
        name: 'Project Falcon',
        samAccountName: 'project.falcon',
        groupScope: 'global',
        groupType: 'security',
        memberCount: 0,
      });
      expect(res.json<{ distinguishedName: string }>().distinguishedName).toBe(CREATED);
      expect(await directoryGroup(CREATED)).toMatchObject({
        groupType: '-2147483646',
        sAMAccountName: 'project.falcon',
        description: 'Falcon project team',
      });
      expect(await groupId('Project Falcon')).toBe(group.id);
      const contents = await operator.get(`/api/ous/contents?dn=${encodeURIComponent(GROUPS_OU)}`);
      expect(contents.json<{ groups: { id: string }[] }>().groups.map((g) => g.id)).toContain(
        group.id,
      );
      expect(await auditRows('group.create')).toEqual([
        expect.objectContaining({
          result: 'success',
          target_type: 'group',
          target_id: group.id,
          target_dn: CREATED,
          metadata_json: {
            parentDn: GROUPS_OU,
            name: 'Project Falcon',
            samAccountName: 'project.falcon',
            scope: 'global',
            type: 'security',
          },
        }),
      ]);
    });

    it('sets the group-type bits for a universal distribution group', async () => {
      const res = await operator.post('/api/groups', {
        parentDn: GROUPS_OU,
        name: 'Falcon Mail',
        samAccountName: 'falcon.mail',
        scope: 'universal',
        type: 'distribution',
      });

      expect(res.statusCode).toBe(200);
      expect((await directoryGroup(DISTRIBUTION))?.groupType).toBe('8');
    });

    it('refuses names already taken, saying by whom, and writes nothing', async () => {
      const sameName = await operator.post('/api/groups', {
        ...newGroup,
        name: 'Engineering',
        samAccountName: 'eng.two',
      });
      const sameSam = await operator.post('/api/groups', {
        ...newGroup,
        name: 'Alice Fans',
        samAccountName: 'alice.anders',
      });

      expect([sameName.statusCode, sameSam.statusCode]).toEqual([409, 409]);
      expect(sameName.json<{ error: { message: string } }>().error.message).toContain(ENGINEERING);
      expect(sameSam.json<{ error: { message: string } }>().error.message).toContain(
        'alice.anders',
      );
      expect(await directoryGroup(`CN=Alice Fans,${GROUPS_OU}`)).toBeNull();
      expect((await auditRows('group.create')).filter((r) => r.result === 'failure')).toHaveLength(
        2,
      );
    });

    it('refuses an OU OpenADUC doesn’t know', async () => {
      const res = await operator.post('/api/groups', {
        ...newGroup,
        parentDn: 'OU=Nowhere,DC=openaduc,DC=test',
      });

      expect(res.statusCode).toBe(400);
    });

    it('needs step-up', async () => {
      const unelevated = api.client();
      await unelevated.signIn(api, 'oa.operator');

      const res = await unelevated.post('/api/groups', { ...newGroup, name: 'Never' });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    });
  });

  describe('delete', () => {
    it('shows the member count and parent groups before deleting', async () => {
      const engineering = (await groupId('Engineering'))!;
      const allStaff = (await groupId('All Staff'))!;

      const res = await admin.get(`/api/groups/${engineering}/delete-preflight`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: engineering,
        name: 'Engineering',
        samAccountName: 'Engineering',
        distinguishedName: ENGINEERING,
        memberCount: 2,
        memberOf: [
          { id: allStaff, name: 'All Staff', distinguishedName: ALL_STAFF, protected: false },
        ],
        primaryGroupMembers: 0,
        blockedReason: null,
        role: null,
      });
    });

    it('refuses a wrong confirmation', async () => {
      const id = (await groupId('Project Falcon'))!;

      const res = await admin.delete(`/api/groups/${id}`, { confirmSamAccountName: 'Engineering' });

      expect(res.statusCode).toBe(400);
      expect(await directoryGroup(CREATED)).not.toBeNull();
    });

    it('deletes a group, audits its members, and drops it and its memberships from the cache', async () => {
      const id = (await groupId('Project Falcon'))!;
      const allStaff = (await groupId('All Staff'))!;
      const alice = (await admin.get('/api/users?q=alice.anders')).json<{
        rows: { id: string }[];
      }>().rows[0]!.id;
      await admin.post(`/api/groups/${id}/groups`, { groupId: allStaff });
      await admin.post(`/api/users/${alice}/groups`, { groupId: id });
      const preflight = await admin.get(`/api/groups/${id}/delete-preflight`);
      expect(preflight.json()).toMatchObject({ memberCount: 1, memberOf: [{ id: allStaff }] });

      const res = await admin.delete(`/api/groups/${id}`, {
        confirmSamAccountName: 'Project.Falcon',
      });

      expect(res.statusCode).toBe(200);
      expect(await directoryGroup(CREATED)).toBeNull();
      expect(await groupId('Project Falcon')).toBeUndefined();
      const parent = (await admin.get(`/api/groups/${allStaff}`)).json<{
        group: { members: { id: string }[] };
      }>().group;
      expect(parent.members.map((m) => m.id)).not.toContain(id);
      const memberships = await api.app.db
        .selectFrom('user_group_memberships')
        .select('user_object_guid')
        .where('group_object_guid', '=', id)
        .execute();
      expect(memberships).toEqual([]);
      const aliceRow = await api.app.db
        .selectFrom('user_cache_records')
        .select('raw_attributes_json')
        .where('object_guid', '=', alice)
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(aliceRow.raw_attributes_json)).not.toContain('Project Falcon');
      const [row] = await auditRows('group.delete');
      expect(row).toMatchObject({
        result: 'success',
        target_type: 'group',
        target_id: id,
        target_dn: CREATED,
        before_json: {
          samAccountName: 'project.falcon',
          members: [`CN=Alice Anders,${STAFF_OU}`],
          memberOf: [ALL_STAFF],
        },
      });
    });

    it('refuses groups AD, Windows or OpenADUC rely on, saying why, and audits the refusal', async () => {
      await asAdministrator(async (client) => {
        await client.add(PROTECTED, {
          objectClass: ['top', 'group'],
          sAMAccountName: 'tier.zero',
          adminCount: '1',
        });
        await client.add(NESTED, { objectClass: ['top', 'group'], sAMAccountName: 'tier.nested' });
        await client.modify(
          DOMAIN_ADMINS,
          new Change({
            operation: 'add',
            modification: new Attribute({ type: 'member', values: [NESTED] }),
          }),
        );
        await client.add(PRIMARY, {
          objectClass: ['top', 'group'],
          sAMAccountName: 'primary.home',
        });
      });
      sambaTool('user', 'create', 'prim.test', DC.password, '--userou=OU=Staff,OU=OpenADUC Test');
      await setGroupMember(PRIMARY, 'prim.test', true);
      await api.app.services.sync.runOnce(api.directoryId!, 'groups.full');
      const primarySid = (await api.app.db
        .selectFrom('group_cache_records')
        .select('sid')
        .where('distinguished_name', '=', PRIMARY)
        .executeTakeFirstOrThrow())!.sid!;
      await setUserAttribute('prim.test', 'primaryGroupID', [primarySid.split('-').at(-1)!]);

      const cases = [
        ['Domain Admins', 'critical_system_object', /critical system object/],
        ['Administrators', 'critical_system_object', /critical system object/],
        ['Tier Zero', 'protected_group', /protected administrative group/],
        ['OpenADUC Operators', 'role_group', /grants OpenADUC's operator role/],
        [
          'Tier Nested',
          'member_of_protected_group',
          /member of the protected group CN=Domain Admins/,
        ],
        ['Primary Home', 'primary_group', /primary group of 1 account/],
      ] as const;

      for (const [name, reason, message] of cases) {
        const id = (await groupId(name))!;
        const preflight = await admin.get(`/api/groups/${id}/delete-preflight`);
        const sam = preflight.json<{ samAccountName: string }>().samAccountName;
        const res = await admin.delete(`/api/groups/${id}`, { confirmSamAccountName: sam });

        expect([name, preflight.json<{ blockedReason: string }>().blockedReason]).toEqual([
          name,
          reason,
        ]);
        expect(res.statusCode).toBe(409);
        expect(res.json<{ error: { message: string } }>().error.message).toMatch(message);
      }
      const operators = (await groupId('OpenADUC Operators'))!;
      expect((await admin.get(`/api/groups/${operators}/delete-preflight`)).json()).toMatchObject({
        role: 'operator',
      });
      const nested = (await groupId('Tier Nested'))!;
      expect(
        (await admin.get(`/api/groups/${nested}/delete-preflight`)).json<{
          memberOf: { distinguishedName: string; protected: boolean }[];
        }>().memberOf,
      ).toContainEqual(
        expect.objectContaining({ distinguishedName: DOMAIN_ADMINS, protected: true }),
      );
      const primary = (await groupId('Primary Home'))!;
      expect((await admin.get(`/api/groups/${primary}/delete-preflight`)).json()).toMatchObject({
        primaryGroupMembers: 1,
      });
      for (const dn of [PROTECTED, NESTED, PRIMARY])
        expect(await directoryGroup(dn)).not.toBeNull();
      const refusals = (await auditRows('group.delete')).filter((r) => r.result === 'failure');
      expect(
        refusals.map((r) => (r.metadata_json as { blockedReason: string }).blockedReason),
      ).toEqual(cases.map(([, reason]) => reason));
      expect(refusals[3]?.metadata_json).toMatchObject({
        errorMessage: "this group grants OpenADUC's operator role",
      });
    });
  });

  describe('capabilities', () => {
    it('refuses create to an operator without write:group.create, and audits the denial', async () => {
      const res = await auditor.post('/api/groups', { ...newGroup, name: 'Auditors Club' });
      const check = await auditor.get(
        `/api/groups/name-check?parentDn=${encodeURIComponent(GROUPS_OU)}&name=x`,
      );

      expect([res.statusCode, check.statusCode]).toEqual([403, 403]);
      expect(await directoryGroup(`CN=Auditors Club,${GROUPS_OU}`)).toBeNull();
      expect((await auditRows('authz.deny')).map((r) => r.metadata_json)).toContainEqual({
        requiredCapability: 'write:group.create',
        route: '/api/groups',
      });
    });

    it('keeps delete to admins: operators get write:group.create but not write:group.delete', async () => {
      const id = (await groupId('Falcon Mail'))!;

      const preflight = await operator.get(`/api/groups/${id}/delete-preflight`);
      const res = await operator.delete(`/api/groups/${id}`, {
        confirmSamAccountName: 'falcon.mail',
      });

      expect([preflight.statusCode, res.statusCode]).toEqual([403, 403]);
      expect(await directoryGroup(DISTRIBUTION)).not.toBeNull();
      expect((await auditRows('authz.deny')).map((r) => r.metadata_json)).toContainEqual({
        requiredCapability: 'write:group.delete',
        route: '/api/groups/:id',
      });
    });
  });
});
