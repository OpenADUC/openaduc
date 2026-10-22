// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  sambaTool,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const SAM = 'tree.test';
const DN = `CN=${SAM},OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test`;

// A disabled user with a container inside it holding one more object, like
// an Exchange ActiveSync devices container with a device. (classStore is one
// of the few classes Samba's schema allows under a user.)
const CHILDREN = [`CN=Devices,${DN}`, `CN=Phone,CN=Devices,${DN}`];

async function removeUserWithChildren(): Promise<void> {
  await asAdministrator(async (c) => {
    for (const dn of [...CHILDREN].reverse().concat(DN)) await c.del(dn).catch(() => undefined);
  });
}

async function createUserWithChild(): Promise<void> {
  await removeUserWithChildren();
  sambaTool('user', 'create', SAM, 'OpenADUC-dev-User1', '--userou=OU=Staff,OU=OpenADUC Test');
  sambaTool('user', 'disable', SAM);
  await asAdministrator(async (c) => {
    for (const dn of CHILDREN) await c.add(dn, { objectClass: 'classStore' });
  });
}

describe('deleting a user that has child objects', () => {
  let api: TestApi;
  let admin: TestClient;

  const userId = async (sam: string) => {
    const res = await admin.get(`/api/users?q=${sam}`);
    return res.json<{ rows: { id: string }[] }>().rows[0]!.id;
  };

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
  });
  beforeEach(async () => {
    await createUserWithChild();
    // Each run recreates the account under a new GUID; drop the old row.
    await api.app.db.deleteFrom('user_cache_records').where('sam_account_name', '=', SAM).execute();
    await api.app.services.sync.runOnce(api.directoryId!, 'users.full');
  });
  afterAll(async () => {
    await removeUserWithChildren();
    reseedDirectory(); // brings carol back
    await api?.close();
  });

  it('preflight reports how many objects each account contains, at any depth', async () => {
    const [tree, carol] = [await userId(SAM), await userId('carol.chen')];
    const res = await admin.post('/api/users/delete-preflight', { ids: [tree, carol] });
    const users = res.json<{ users: { id: string; childObjects: number | null }[] }>().users;

    expect(users.find((u) => u.id === tree)?.childObjects).toBe(2);
    expect(users.find((u) => u.id === carol)?.childObjects).toBe(0);
  });

  it('refuses to delete the children without explicit confirmation', async () => {
    const res = await admin.delete(`/api/users/${await userId(SAM)}`, {
      confirmSamAccountName: SAM,
    });

    expect(res.statusCode).toBe(409);
    expect(await readDirectoryUser(SAM, ['cn'])).not.toBeNull();
  });

  it('deletes the account and its children when confirmed, and audits that', async () => {
    const id = await userId(SAM);
    const res = await admin.delete(`/api/users/${id}`, {
      confirmSamAccountName: SAM,
      allowTreeDelete: true,
    });

    expect(res.statusCode).toBe(200);
    expect(await readDirectoryUser(SAM, ['cn'])).toBeNull();
    const audit = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'after_json', 'metadata_json'])
      .where('action', '=', 'user.delete')
      .where('target_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(audit.result).toBe('success');
    expect(audit.after_json).toMatchObject({ treeDelete: true });
    expect(audit.metadata_json).toMatchObject({ allowTreeDelete: true });
  });

  it('deletes an account without children as before', async () => {
    const res = await admin.delete(`/api/users/${await userId('carol.chen')}`, {
      confirmSamAccountName: 'carol.chen',
    });
    expect(res.statusCode).toBe(200);
  });
});
