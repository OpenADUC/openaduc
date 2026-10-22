// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, startApi, type TestApi, type TestClient } from './harness.js';

const DOMAIN_ADMINS = `CN=Domain Admins,CN=Users,${DC.baseDn}`;

type Role = { groupDn: string | null; groupName: string | null; memberCount: number | null };

describe('mapping roles to AD groups', () => {
  let api: TestApi;
  let admin: TestClient;

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api); // signed in and stepped up as oa.admin
  });
  afterAll(async () => {
    await api?.close();
  });

  const roles = async () =>
    (await admin.get('/api/settings/roles')).json<{ roles: Record<string, Role> }>().roles;
  const signInAs = async (sam: string) =>
    api.client().post('/api/auth/login', {
      directoryId: api.directoryId,
      username: sam,
      password: DC.password,
    });

  it('shows each role’s group and how many direct members it has', async () => {
    const r = await roles();
    expect(r.admin).toMatchObject({ groupDn: DOMAIN_ADMINS, groupName: 'Domain Admins' });
    expect(r.operator).toMatchObject({ groupName: 'OpenADUC Operators', memberCount: 1 });
  });

  it('takes effect at the next sign-in, without a restart', async () => {
    expect((await admin.put('/api/settings/roles', { operator: null })).statusCode).toBe(200);
    expect((await signInAs('oa.operator')).statusCode).toBe(401);

    expect(
      (await admin.put('/api/settings/roles', { operator: DC.groups.operators })).statusCode,
    ).toBe(200);
    const res = await signInAs('oa.operator');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ actor: { capabilities: string[] } }>().actor.capabilities).toContain(
      'write:user.unlock',
    );
  });

  it('is audited with the old and new groups', async () => {
    await admin.put('/api/settings/roles', { auditor: null });
    await admin.put('/api/settings/roles', { auditor: DC.groups.auditors });
    const row = await api.app.db
      .selectFrom('audit_events')
      .select(['before_json', 'after_json'])
      .where('action', '=', 'settings.roles.update')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.before_json).toMatchObject({ auditor: null });
    expect(row.after_json).toMatchObject({ auditor: DC.groups.auditors });
  });

  it('rejects a group that isn’t in the directory', async () => {
    const res = await admin.put('/api/settings/roles', {
      operator: `CN=No Such Group,${DC.baseDn}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('asks for confirmation before an admin moves the admin role to a group they’re not in', async () => {
    const res = await admin.put('/api/settings/roles', { admin: DC.groups.auditors });
    expect(res.statusCode).toBe(409);
    expect((await roles()).admin?.groupDn).toBe(DOMAIN_ADMINS);

    const confirmed = await admin.put('/api/settings/roles', {
      admin: DC.groups.auditors,
      confirmAdminChange: true,
    });
    expect(confirmed.statusCode).toBe(200);
    await api.app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(DOMAIN_ADMINS) })
      .where('key', '=', 'authz.admin_group_dn')
      .execute();
    api.app.services.settings.invalidate('authz.admin_group_dn');
  });

  it('needs step-up', async () => {
    const fresh = api.client();
    await fresh.signIn(api, 'oa.admin');
    const res = await fresh.put('/api/settings/roles', { auditor: DC.groups.auditors });
    expect(res.statusCode).toBe(403);
  });
});
