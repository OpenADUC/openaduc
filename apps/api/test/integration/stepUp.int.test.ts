// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, setGroupMember, startApi, type TestApi } from './harness.js';

describe('step-up re-reads the operator’s roles from AD', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterEach(async () => {
    await setGroupMember(DC.groups.operators, 'oa.operator', true);
    await setGroupMember(DC.groups.auditors, 'oa.operator', false);
  });
  afterAll(async () => {
    await api?.close();
  });

  const sessionRow = async (actorUsername: string) =>
    api.app.db
      .selectFrom('admin_sessions')
      .select('expires_at')
      .where('actor_username', '=', actorUsername)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();

  it('drops capabilities the operator has lost since signing in', async () => {
    await setGroupMember(DC.groups.auditors, 'oa.operator', true);
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    await setGroupMember(DC.groups.operators, 'oa.operator', false);
    await operator.stepUp();

    const me = await operator.get('/api/auth/me');
    const caps = me.json<{ actor: { capabilities: string[] } }>().actor.capabilities;
    expect(caps).toContain('view:audit');
    expect(caps).not.toContain('write:user.unlock');

    const users = await operator.get('/api/users?q=dave.diaz');
    const dave = users.json<{ rows: { id: string }[] }>().rows[0]!;
    const unlock = await operator.post(`/api/users/${dave.id}/unlock`);
    expect(unlock.statusCode).toBe(403);
  });

  it('signs the operator out when they have no role left', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    await setGroupMember(DC.groups.operators, 'oa.operator', false);
    const res = await operator.post('/api/auth/step-up', { password: DC.password });

    expect(res.statusCode).toBe(401);
    // The code the web client signs out on.
    expect(res.json()).toMatchObject({ error: { code: 'session_required' } });
    expect((await operator.get('/api/auth/me')).statusCode).toBe(401);
    const audit = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'error_code'])
      .where('action', '=', 'auth.stepup')
      .where('actor_display_name', '=', 'OpenADUC Operator')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ result: 'denied', error_code: 'no_capabilities' });
  });

  it('never extends the session’s absolute expiry', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    const before = await sessionRow(`oa.operator@${DC.domain}`);

    await new Promise((r) => setTimeout(r, 1100));
    await operator.stepUp();
    const after = await sessionRow(`oa.operator@${DC.domain}`);

    expect(new Date(after.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
  });
});
