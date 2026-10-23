// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

const MINUTE = 60_000;

// The clock is faked (Date only, so I/O timers still run) and stands still
// between steps; `at(m)` moves it to m minutes after the test started.
describe('elevated sessions end when idle', () => {
  let api: TestApi;
  let start: number;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  beforeEach(async () => {
    // Each test starts with no password cached.
    const elevated = await api.app.db.selectFrom('elevated_sessions').select('id').execute();
    api.app.services.credentialCache.deleteMany(elevated.map((e) => e.id));
    vi.useFakeTimers({ toFake: ['Date'] });
    start = Date.now();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await api.app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(240) })
      .where('key', '=', 'stepup.absolute_lifetime_minutes')
      .execute();
    api.app.services.settings.invalidate();
  });
  afterAll(async () => {
    await api?.close();
  });

  const at = (minutes: number) => vi.setSystemTime(start + minutes * MINUTE);
  const iso = (minutes: number) => new Date(start + minutes * MINUTE).toISOString();

  async function elevation(client: TestClient) {
    const me = await client.get('/api/auth/me');
    return me.json<{
      actor: {
        elevated: {
          active: boolean;
          idleExpiresAt: string | null;
          absoluteExpiresAt: string | null;
        };
      };
    }>().actor.elevated;
  }

  // A harmless write: any route that needs step-up will do.
  const write = (client: TestClient) =>
    client.patch('/api/settings', { 'audit.account_view_enabled': true });

  async function steppedUpAdmin(): Promise<TestClient> {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
    return admin;
  }

  it('reports the idle end and the absolute end, 15 minutes and 4 hours by default', async () => {
    const admin = await steppedUpAdmin();

    expect(await elevation(admin)).toEqual({
      active: true,
      idleExpiresAt: iso(15),
      absoluteExpiresAt: iso(240),
    });
  });

  it('ends after the idle timeout and drops the cached password without a request', async () => {
    const admin = await steppedUpAdmin();
    expect(api.app.services.credentialCache.size()).toBe(1);

    at(15.1);
    await vi.waitFor(() => expect(api.app.services.credentialCache.size()).toBe(0), {
      timeout: 8000,
      interval: 200,
    });

    const refused = await write(admin);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'step_up_required' } });
    expect((await elevation(admin)).active).toBe(false);
  });

  it('slides the idle end on activity', async () => {
    const admin = await steppedUpAdmin();

    at(10);
    expect((await elevation(admin)).idleExpiresAt).toBe(iso(25));
    at(20);
    expect((await write(admin)).statusCode).toBe(200);
    at(34);
    expect(await elevation(admin)).toMatchObject({ active: true, idleExpiresAt: iso(49) });
  });

  it('tells the client the moved idle end on every response', async () => {
    const admin = await steppedUpAdmin();

    at(10);
    const res = await admin.get('/api/settings');
    expect(res.headers['x-elevated-idle-expires-at']).toBe(iso(25));
  });

  it("doesn't count the SPA's background polling as activity", async () => {
    const admin = await steppedUpAdmin();

    at(10);
    admin.headers['x-background-request'] = '1';
    expect((await admin.get('/api/settings')).headers['x-elevated-idle-expires-at']).toBe(iso(15));
    at(15);
    expect((await elevation(admin)).active).toBe(false);
  });

  it('does not rewrite the session for activity that barely moves the idle end', async () => {
    const admin = await steppedUpAdmin();

    at(0.5);
    expect((await elevation(admin)).idleExpiresAt).toBe(iso(15));
  });

  it('ends at the absolute lifetime however active the operator is', async () => {
    const admin = await steppedUpAdmin();
    expect(
      (await admin.patch('/api/settings', { 'stepup.absolute_lifetime_minutes': 30 })).statusCode,
    ).toBe(200);
    await admin.stepUp();

    at(10);
    expect(await elevation(admin)).toMatchObject({ active: true, absoluteExpiresAt: iso(30) });
    at(20);
    expect(await elevation(admin)).toMatchObject({ active: true, idleExpiresAt: iso(30) });
    at(29.9);
    expect((await write(admin)).statusCode).toBe(200);
    at(30);
    expect((await write(admin)).json()).toMatchObject({ error: { code: 'step_up_required' } });
    expect((await elevation(admin)).active).toBe(false);
  });

  it('makes the limits policy settings that need step-up to change and are audited', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');

    const listed = await admin.get('/api/settings');
    expect(listed.json()).toMatchObject({
      settings: {
        'stepup.idle_timeout_minutes': { value: 15 },
        'stepup.absolute_lifetime_minutes': { value: 240 },
      },
    });
    expect(listed.json().settings['stepup.ttl_minutes']).toBeUndefined();

    const change = { 'stepup.idle_timeout_minutes': 5 };
    const refused = await admin.patch('/api/settings', change);
    expect(refused.json()).toMatchObject({ error: { code: 'step_up_required' } });

    await admin.stepUp();
    expect((await admin.patch('/api/settings', change)).statusCode).toBe(200);
    const audit = await api.app.db
      .selectFrom('audit_events')
      .select(['before_json', 'after_json'])
      .where('action', '=', 'settings.update')
      .where('target_id', '=', 'stepup.idle_timeout_minutes')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ before_json: { value: 15 }, after_json: { value: 5 } });

    // Takes effect at the operator's next activity.
    expect((await elevation(admin)).idleExpiresAt).toBe(iso(5));
    expect(
      (await admin.patch('/api/settings', { 'stepup.idle_timeout_minutes': 15 })).statusCode,
    ).toBe(200);
  });
});
