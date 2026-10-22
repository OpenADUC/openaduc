// SPDX-License-Identifier: BUSL-1.1
// The first configured DC URL points at a port nothing listens on, so every
// operation has to fail over to the dev DC.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  DC,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const DEAD_DC = 'ldaps://localhost:10637';

describe('with the first domain controller down', () => {
  let api: TestApi;
  let operator: TestClient;

  const userId = async (sam: string) => {
    const res = await operator.get(`/api/users?q=${sam}`);
    return res.json<{ rows: { id: string }[] }>().rows[0]!.id;
  };

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    // Setup itself signs in as oa.admin, so this already needs failover.
    await configureDirectory(api, { ldapUrls: [DEAD_DC, DC.ldapsUrl], tlsMode: 'ldaps' });
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
  });

  afterAll(async () => {
    await api?.close();
    reseedDirectory(); // brings back the deleted and renamed fixtures
  });

  it('a wrong password is still refused, not retried into a different error', async () => {
    const res = await api.client().post('/api/auth/login', {
      directoryId: api.directoryId,
      username: 'oa.operator',
      password: 'not-the-password',
    });
    expect(res.statusCode).toBe(401);
  });

  it('unlock works', async () => {
    const res = await operator.post(`/api/users/${await userId('dave.diaz')}/unlock`);
    expect(res.statusCode).toBe(200);
    expect(Number((await readDirectoryUser('dave.diaz', ['lockoutTime']))?.lockoutTime)).toBe(0);
  });

  it('password reset works', async () => {
    const res = await operator.post(`/api/users/${await userId('bob.baker')}/reset-password`, {
      newPassword: `OpenADUC-${Date.now()}-Reset`,
      forceChangeAtNextLogin: true,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rename works', async () => {
    const res = await operator.post(`/api/users/${await userId('alice.anders')}/rename`, {
      displayName: 'Alice A. Anders',
    });
    expect(res.statusCode).toBe(200);
    expect((await readDirectoryUser('alice.anders', ['displayName']))?.displayName).toBe(
      'Alice A. Anders',
    );
  });

  it('delete works', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
    const res = await admin.delete(`/api/users/${await userId('carol.chen')}`, {
      confirmSamAccountName: 'carol.chen',
    });
    expect(res.statusCode).toBe(200);
    expect(await readDirectoryUser('carol.chen', ['cn'])).toBeNull();
  });

  describe('and every domain controller down', () => {
    beforeAll(async () => {
      await api.app.db
        .updateTable('directory_providers')
        .set({ ldap_urls: [DEAD_DC] })
        .execute();
    });

    it('a write fails as directory unavailable, with no permission-denied audit row', async () => {
      const id = (
        await api.app.db
          .selectFrom('user_cache_records')
          .select('object_guid')
          .where('sam_account_name', '=', 'dave.diaz')
          .executeTakeFirstOrThrow()
      ).object_guid;
      const res = await operator.post(`/api/users/${id}/unlock`);

      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('directory_unavailable');
      const denied = await api.app.db
        .selectFrom('audit_events')
        .select('id')
        .where('error_code', '=', 'permission_denied')
        .execute();
      expect(denied).toEqual([]);
    });

    it('the operator bind itself reports directory_error, not permission_denied', async () => {
      const provider = await api.app.services.providers.buildWithCreds(api.directoryId!, {
        username: `${DC.serviceAccount}@${DC.domain}`,
        password: DC.password,
      });
      const result = await provider.unlockUser(
        { kind: 'samAccountName', value: 'dave.diaz' },
        {
          actorUserId: 'test',
          actorUsername: `oa.operator@${DC.domain}`,
          actorPassword: DC.password,
          correlationId: 'test',
        },
      );
      expect(result).toMatchObject({ ok: false, reason: 'directory_error' });
    });
  });
});
