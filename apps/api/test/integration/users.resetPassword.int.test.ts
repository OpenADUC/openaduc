// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  DC,
  readDirectoryUser,
  reseedDirectory,
  sambaTool,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const isLocked = async (sam: string) => {
  const entry = await readDirectoryUser(sam, ['lockoutTime']);
  return Number(entry?.lockoutTime ?? 0) > 0;
};
const pwdLastSet = async (sam: string) =>
  (await readDirectoryUser(sam, ['pwdLastSet']))?.pwdLastSet;

describe('resetting a locked-out user’s password', () => {
  let api: TestApi;
  let operator: TestClient;
  let daveId: string;

  const resetDave = (body: Record<string, unknown>) =>
    operator.post(`/api/users/${daveId}/reset-password`, body);
  const auditRows = (action: string) =>
    api.app.db
      .selectFrom('audit_events')
      .select(['result', 'metadata_json', 'before_json', 'after_json'])
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
    const search = await operator.get('/api/users?q=dave.diaz');
    daveId = search.json<{ rows: { id: string }[] }>().rows[0]!.id;
  });

  afterAll(async () => {
    await api?.close();
    // Other tests sign in as Dave with the fixture password, locked.
    sambaTool('user', 'setpassword', 'dave.diaz', `--newpassword=${DC.password}`);
    reseedDirectory();
  });

  it('offers the domain’s password policy to check a new password against', async () => {
    const res = await operator.get(`/api/directories/${api.directoryId}/policy`);

    expect(res.json<{ policy: unknown }>().policy).toMatchObject({
      minPwdLength: 7,
      complexityRequired: true,
      pwdHistoryLength: 24,
    });
  });

  it('needs the unlock capability too when asked to unlock', async () => {
    const before = await pwdLastSet('dave.diaz');
    await api.app.db
      .updateTable('admin_sessions')
      .set({
        capabilities_json: JSON.stringify(['read:user', 'write:user.resetPassword']),
      })
      .where('actor_username', '=', `oa.operator@${DC.domain}`)
      .where('revoked_at', 'is', null)
      .execute();

    const res = await resetDave({ newPassword: 'Unused-Reset-9a', unlock: true });

    expect(res.statusCode).toBe(403);
    expect(await isLocked('dave.diaz')).toBe(true);
    expect(await pwdLastSet('dave.diaz')).toEqual(before);
    const deny = (await auditRows('authz.deny')).at(-1);
    expect(deny?.metadata_json).toEqual({
      requiredCapability: 'write:user.unlock',
      route: '/api/users/:id/reset-password',
    });
    expect(await auditRows('user.password.reset')).toEqual([]);

    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
  });

  it('leaves the account locked when the directory rejects the password', async () => {
    const res = await resetDave({ newPassword: 'alllowercase', unlock: true });

    expect(res.statusCode).toBe(400);
    expect(await isLocked('dave.diaz')).toBe(true);
    const rows = await auditRows('user.password.reset');
    expect(rows.map((r) => r.result)).toEqual(['failure']);
  });

  it('changes the password and clears the lockout as one audited change', async () => {
    const before = await pwdLastSet('dave.diaz');

    const res = await resetDave({
      newPassword: `Reset-${Date.now()}-Ok`,
      forceChangeAtNextLogin: false,
      unlock: true,
    });

    expect(res.statusCode).toBe(200);
    expect(await isLocked('dave.diaz')).toBe(false);
    expect(await pwdLastSet('dave.diaz')).not.toEqual(before);

    const cached = await api.app.db
      .selectFrom('user_cache_records')
      .select('locked')
      .where('object_guid', '=', daveId)
      .executeTakeFirstOrThrow();
    expect(cached.locked).toBe(false);

    const success = (await auditRows('user.password.reset')).filter((r) => r.result === 'success');
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      metadata_json: { forceChangeAtNextLogin: false, unlock: true },
      before_json: { locked: true },
      after_json: { locked: false, forceChangeAtNextLogin: false },
    });
    expect(await auditRows('user.unlock')).toEqual([]);
  });
});
