// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi } from './harness.js';

// The guard each route's declared policy puts in front of it.
describe('route policy guard', () => {
  let api: TestApi;
  let daveId: string;

  beforeAll(async () => {
    api = await startApi();
    const admin = await configureDirectory(api);
    const users = await admin.get('/api/users?q=dave.diaz');
    daveId = users.json<{ rows: { id: string }[] }>().rows[0]!.id;
  });
  afterAll(async () => {
    await api?.close();
  });

  it('asks for a session on routes that need one, HEAD included', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await api.client().request(method, '/api/users');
      expect(res.statusCode).toBe(401);
    }
  });

  it('refuses a missing capability and audits the denial', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');

    const res = await auditor.post(`/api/users/${daveId}/unlock`);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
    const row = await api.app.db
      .selectFrom('audit_events')
      .select('metadata_json')
      .where('action', '=', 'authz.deny')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.metadata_json).toEqual({
      requiredCapability: 'write:user.unlock',
      route: '/api/users/:id/unlock',
    });
  });

  it('asks for step-up before a write', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    const res = await operator.post(`/api/users/${daveId}/unlock`);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });
  });

  it('asks for step-up before changing settings', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    const change = { 'audit.account_view_enabled': false };

    const refused = await admin.patch('/api/settings', change);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'step_up_required' } });
    expect(await api.app.services.settings.get('audit.account_view_enabled', null)).toBe(true);

    await admin.stepUp();
    expect((await admin.patch('/api/settings', change)).statusCode).toBe(200);
    expect(await api.app.services.settings.get('audit.account_view_enabled', null)).toBe(false);
  });

  it('asks for step-up before running or resetting sync tasks', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    const dir = `/api/directories/${api.directoryId}`;
    const routes = [
      `${dir}/sync`,
      `${dir}/sync/reset`,
      `${dir}/sync-tasks/users.delta/run`,
      `${dir}/sync-tasks/users.delta/reset`,
    ];

    for (const url of routes) {
      const res = await admin.post(url);
      expect({ url, code: res.json().error?.code }).toEqual({ url, code: 'step_up_required' });
    }

    await admin.stepUp();
    for (const url of routes) {
      const res = await admin.post(url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it("answers 404 for a directory id that isn't the caller's", async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    const other = await operator.get(`/api/directories/${api.directoryId! + 1}/policy`);
    expect(other.statusCode).toBe(404);

    const own = await operator.get(`/api/directories/${api.directoryId}/policy`);
    expect(own.statusCode).toBe(200);
  });
});
