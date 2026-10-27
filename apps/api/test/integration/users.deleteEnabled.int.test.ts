// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  sambaTool,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const SAM = 'still.enabled';
const DN = `CN=${SAM},OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test`;

type Preflight = { users: { id: string; blockedReason: string | null }[] };

// Only disabled accounts can be deleted. AD is the judge, not the cache: an
// account the list still shows as disabled may have been enabled since.
describe('deleting an enabled user', () => {
  let api: TestApi;
  let admin: TestClient;
  let id: string;

  const setCachedEnabled = (enabled: boolean) =>
    api.app.db
      .updateTable('user_cache_records')
      .set({ enabled })
      .where('object_guid', '=', id)
      .execute();

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
    await asAdministrator((c) => c.del(DN).catch(() => undefined));
    sambaTool('user', 'create', SAM, 'OpenADUC-dev-User1', '--userou=OU=Staff,OU=OpenADUC Test');
    await api.app.services.sync.runOnce(api.directoryId!, 'users.full');
    const res = await admin.get(`/api/users?q=${SAM}`);
    id = res.json<{ rows: { id: string }[] }>().rows[0]!.id;
  });
  afterAll(async () => {
    await asAdministrator((c) => c.del(DN).catch(() => undefined));
    await api?.close();
  });

  it('is refused by the preflight', async () => {
    const res = await admin.post('/api/users/delete-preflight', { ids: [id] });

    expect(res.json<Preflight>().users).toEqual([
      expect.objectContaining({ id, blockedReason: 'enabled' }),
    ]);
  });

  it('is refused by the delete, which leaves the account in AD', async () => {
    await setCachedEnabled(false);

    const res = await admin.delete(`/api/users/${id}`, { confirmSamAccountName: SAM });

    expect(res.statusCode).toBe(409);
    expect(await readDirectoryUser(SAM, ['userAccountControl'])).not.toBeNull();
  });
});
