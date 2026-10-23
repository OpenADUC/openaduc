// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  DC,
  expectOk,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const initializeBody = (adminUsername: string) => ({
  domain: DC.domain,
  baseDn: DC.baseDn,
  ldapUrls: [DC.ldapsUrl],
  tlsMode: 'ldaps',
  adminUsername,
  adminPassword: DC.password,
});

describe('first-run setup', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  const configuredCount = async () =>
    (await api.app.db.selectFrom('directory_providers').select('id').execute()).length;

  it('refuses an account outside the admin group, and saves nothing', async () => {
    const res = await api.client().post('/api/setup/initialize', initializeBody('alice.anders'));

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Domain Admins');
    expect(res.cookies.some((c) => c.name === 'openaduc_sid' && c.value)).toBe(false);
    expect(await configuredCount()).toBe(0);
  });

  it('lets exactly one of two simultaneous attempts configure the directory', async () => {
    const [a, b] = await Promise.all([
      api.client().post('/api/setup/initialize', initializeBody('oa.admin')),
      api.client().post('/api/setup/initialize', initializeBody('oa.admin')),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect(await configuredCount()).toBe(1);
  });
});

describe('first-run setup with an admin group already configured', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    // Any non-default group will do; Operators keeps oa.admin out of it.
    await api.app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(DC.groups.operators) })
      .where('key', '=', 'authz.admin_group_dn')
      .execute();
    api.app.services.settings.invalidate('authz.admin_group_dn');
  });
  afterAll(async () => {
    await api?.close();
  });

  const adminGroupSetting = async () =>
    (
      await api.app.db
        .selectFrom('app_settings')
        .select('value_json')
        .where('key', '=', 'authz.admin_group_dn')
        .executeTakeFirstOrThrow()
    ).value_json;

  it('refuses a Domain Admin outside that group, and names the group', async () => {
    const res = await api.client().post('/api/setup/initialize', initializeBody('oa.admin'));

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('OpenADUC Operators');
  });

  it('accepts a member of that group and keeps the setting', async () => {
    const res = await api.client().post('/api/setup/initialize', initializeBody('oa.operator'));

    expect(res.statusCode).toBe(200);
    expect(await adminGroupSetting()).toBe(DC.groups.operators);
  });
});

describe('after setup', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('the status endpoint tells anonymous callers only that setup is done', async () => {
    const res = await api.client().get('/api/setup/status');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      onboardingComplete: true,
      hasServiceAccount: false,
      onboardingCompletedAt: null,
      existingDirectory: null,
    });
    expect(res.body).not.toContain('localhost');
    expect(res.body).not.toContain(DC.serviceAccount);
    expect(res.body).not.toContain(DC.baseDn);
  });
});

describe('the later setup steps', () => {
  let api: TestApi;
  let admin: TestClient;

  beforeAll(async () => {
    api = await startApi();
    // Only the first step: onboarding stays open.
    admin = api.client();
    const init = await admin.post('/api/setup/initialize', initializeBody('oa.admin'));
    expect(init.statusCode).toBe(200);
    api.directoryId = init.json<{ directory: { id: number } }>().directory.id;
    await api.app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(DC.groups.operators) })
      .where('key', '=', 'authz.operator_group_dn')
      .execute();
    api.app.services.settings.invalidate('authz.operator_group_dn');
  });
  afterAll(async () => {
    await api?.close();
  });

  it('reject a signed-in operator who is not an admin', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    const res = await operator.post('/api/setup/service-account', {
      username: DC.serviceAccount,
      password: DC.password,
    });
    expect(res.statusCode).toBe(403);
  });

  it('do not show the directory to a signed-in operator who is not an admin', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    const res = await operator.get('/api/setup/status');
    expect(res.json<{ existingDirectory: unknown }>().existingDirectory).toBeNull();
  });

  it('reject cross-site requests that ride the admin’s session', async () => {
    admin.headers.origin = 'https://evil.example';
    const res = await admin.post('/api/setup/policy', {
      passwordExpiringDays: 1,
      staleLogonDays: 1,
    });
    delete admin.headers.origin;
    expect(res.statusCode).toBe(403);
  });

  // Setup/initialize opens an elevated session, so normally they don't ask.
  it('need a live step-up', async () => {
    const body = { passwordExpiringDays: 14, staleLogonDays: 90 };
    expectOk(await admin.delete('/api/auth/step-up'), 'end step-up');

    const refused = await admin.post('/api/setup/policy', body);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'step_up_required' } });

    await admin.stepUp();
    expect((await admin.post('/api/setup/policy', body)).statusCode).toBe(200);
  });
});
