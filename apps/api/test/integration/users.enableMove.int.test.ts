// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const ROOT = 'OU=OpenADUC Test,DC=openaduc,DC=test';
const ALICE = `CN=Alice Anders,OU=Staff,${ROOT}`;
const CONTRACTORS = `OU=Contractors,${ROOT}`;

const putAliceBack = () =>
  asAdministrator(async (client) => {
    await client.modifyDN(`CN=Alice Anders,${CONTRACTORS}`, ALICE).catch(() => undefined);
  });

// Users and computers share the provider's disable and move; this keeps the
// user side covered.
describe('disabling, enabling and moving a user', () => {
  let api: TestApi;
  let operator: TestClient;
  let alice: string;

  const uac = async () =>
    Number((await readDirectoryUser('alice.anders', ['userAccountControl']))?.userAccountControl);

  beforeAll(async () => {
    await putAliceBack();
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    alice = (await operator.get('/api/users?q=alice.anders')).json<{ rows: { id: string }[] }>()
      .rows[0]!.id;
  });

  afterAll(async () => {
    await api?.close();
    await putAliceBack();
    reseedDirectory();
  });

  it('disables and enables the account, keeping its other bits', async () => {
    const before = await uac();

    expect((await operator.post(`/api/users/${alice}/disable`)).statusCode).toBe(200);
    expect(await uac()).toBe(before | 0x2);
    expect((await operator.post(`/api/users/${alice}/enable`)).statusCode).toBe(200);
    expect(await uac()).toBe(before & ~0x2);
  });

  it('moves the account to another OU and back', async () => {
    expect(
      (await operator.post(`/api/users/${alice}/move`, { targetOuDn: CONTRACTORS })).statusCode,
    ).toBe(200);
    expect((await readDirectoryUser('alice.anders', ['cn']))?.dn).toBe(
      `CN=Alice Anders,${CONTRACTORS}`,
    );

    expect(
      (await operator.post(`/api/users/${alice}/move`, { targetOuDn: `OU=Staff,${ROOT}` }))
        .statusCode,
    ).toBe(200);
    expect((await readDirectoryUser('alice.anders', ['cn']))?.dn).toBe(ALICE);
  });
});
