// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, reseedDirectory, startApi, type TestApi } from './harness.js';

// The web client signs the operator out on `session_required` and on
// nothing else, so only a missing or dead session may carry that code.
describe('401 session_required', () => {
  let api: TestApi;

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('answers a request with no session', async () => {
    const res = await api.client().get('/api/users');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'session_required' } });
  });

  it('answers a request whose session was revoked', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await api.app.db.updateTable('admin_sessions').set({ revoked_at: new Date() }).execute();

    const res = await operator.get('/api/users');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'session_required' } });
  });

  it('is not used for a rejected password typed into a form', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();

    const res = await admin.post('/api/setup/service-account', {
      username: 'svc-openaduc',
      password: 'not-the-password',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).not.toMatchObject({ error: { code: 'session_required' } });
  });
});
