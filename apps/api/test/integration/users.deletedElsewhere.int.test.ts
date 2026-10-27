// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  reseedDirectory,
  sambaTool,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const SAM = 'gone.elsewhere';
const DN = `CN=${SAM},OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test`;

// No sync removes an account deleted outside OpenADUC from the cache, so it
// stays listed. Deleting it from OpenADUC failed with "user not found" and
// left it there; a live read now takes it out of the cache instead.
describe('a user deleted outside OpenADUC', () => {
  let api: TestApi;
  let admin: TestClient;
  let id: string;

  const cached = () =>
    api.app.db
      .selectFrom('user_cache_records')
      .select(['deleted_at'])
      .where('object_guid', '=', id)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
  });
  beforeEach(async () => {
    await asAdministrator((c) => c.del(DN).catch(() => undefined));
    sambaTool('user', 'create', SAM, 'OpenADUC-dev-User1', '--userou=OU=Staff,OU=OpenADUC Test');
    sambaTool('user', 'disable', SAM);
    await api.app.db.deleteFrom('user_cache_records').where('sam_account_name', '=', SAM).execute();
    await api.app.services.sync.runOnce(api.directoryId!, 'users.full');
    const res = await admin.get(`/api/users?q=${SAM}`);
    id = res.json<{ rows: { id: string }[] }>().rows[0]!.id;
    // Gone from AD, still in the cache.
    await asAdministrator((c) => c.del(DN));
  });
  afterAll(async () => {
    await asAdministrator((c) => c.del(DN).catch(() => undefined));
    await api?.close();
  });

  it('preflight reports it as not found and drops it from the list', async () => {
    const res = await admin.post('/api/users/delete-preflight', { ids: [id] });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ users: { blockedReason: string | null }[] }>().users).toEqual([
      expect.objectContaining({ blockedReason: 'not_found' }),
    ]);
    expect((await cached()).deleted_at).not.toBeNull();
    const list = await admin.get(`/api/users?q=${SAM}`);
    expect(list.json<{ rows: unknown[] }>().rows).toHaveLength(0);
  });

  it('a delete answers 404, audits nothing, and drops it from the list', async () => {
    const res = await admin.delete(`/api/users/${id}`, { confirmSamAccountName: SAM });

    expect(res.statusCode).toBe(404);
    expect((await cached()).deleted_at).not.toBeNull();
    const audit = await api.app.db
      .selectFrom('audit_events')
      .select('id')
      .where('action', '=', 'user.delete')
      .where('target_id', '=', id)
      .execute();
    expect(audit).toHaveLength(0);
  });

  it('opening it answers 404 and drops it from the list', async () => {
    const res = await admin.get(`/api/users/${id}`);

    expect(res.statusCode).toBe(404);
    expect((await cached()).deleted_at).not.toBeNull();
  });
});
