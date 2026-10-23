// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDirectory,
  configureDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

// Two directories on one installation: an operator signed into one must not
// reach the other's data by putting its id in the URL.
describe('an operator signed into one directory', () => {
  let api: TestApi;
  let admin: TestClient;
  let dirA: number;
  let dirB: number;
  let eventB: number;
  let userB: string;

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api);
    dirA = api.directoryId!;
    dirB = await addDirectory(admin, 'second');

    for (const id of [dirA, dirB]) {
      await api.app.services.entraIntegration.create(id, {
        tenantId: '11111111-2222-4333-8444-555555555555',
        clientId: `client-${id}`,
        clientSecret: 'not-a-real-secret',
        features: { photos: true, signInEvents: true, mfaRegistration: true },
      });
    }
    const event = await api.app.db
      .insertInto('entra_signin_events')
      .values({
        provider_id: dirB,
        entra_event_id: 'b-event',
        user_principal_name: 'someone@openaduc.test',
        ip_address: '203.0.113.7',
        app_display_name: 'Secret App',
        created_date_time: new Date(),
        auth_methods: JSON.stringify([]),
        detail_json: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    eventB = Number(event.id);
    userB = '00000000-0000-0000-0000-000000000001';
  });
  afterAll(async () => {
    await api?.close();
  });

  it("gets 404 for the other directory's Entra data", async () => {
    const operator = api.client();
    await operator.signInTo(dirA, 'oa.operator');

    for (const url of [
      `/api/directories/${dirB}/entra`,
      `/api/directories/${dirB}/signin-events`,
      `/api/directories/${dirB}/signin-events/apps`,
      `/api/directories/${dirB}/signin-events/${eventB}`,
      `/api/directories/${dirB}/mfa-registration`,
      `/api/directories/${dirB}/mfa-registration/methods`,
      `/api/directories/${dirB}/users/${userB}/photo`,
    ]) {
      const res = await operator.get(url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
      expect(res.body).not.toContain('Secret App');
    }

    const own = await operator.get(`/api/directories/${dirA}/entra`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ integration: { clientId: `client-${dirA}` } });
  });

  it("can't change or test the other directory's Entra config", async () => {
    // configureDirectory left the admin signed into A and stepped up.
    const put = await admin.put(`/api/directories/${dirB}/entra`, {
      tenantId: '11111111-2222-4333-8444-555555555555',
      clientId: 'hijacked',
    });
    expect(put.statusCode).toBe(404);
    expect((await admin.post(`/api/directories/${dirB}/entra/test`)).statusCode).toBe(404);
    expect((await admin.delete(`/api/directories/${dirB}/entra`)).statusCode).toBe(404);

    const integration = await api.app.services.entraIntegration.getByProviderId(dirB);
    expect(integration).toMatchObject({ clientId: `client-${dirB}` });
  });

  it('needs step-up to test its own Entra config', async () => {
    const other = api.client();
    await other.signInTo(dirA, 'oa.admin');

    const res = await other.post(`/api/directories/${dirA}/entra/test`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });
  });
});
