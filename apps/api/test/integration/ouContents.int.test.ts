// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

const ROOT = 'OU=OpenADUC Test,DC=openaduc,DC=test';
const SERVICE_ACCOUNTS = `OU=Service Accounts,${ROOT}`;
const WORKSTATIONS = `OU=Workstations,${ROOT}`;

describe('an OU’s contents', () => {
  let api: TestApi;
  let operator: TestClient;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
  });
  afterAll(async () => {
    await api?.close();
  });

  const contents = async (dn: string) =>
    (await operator.get(`/api/ous/contents?dn=${encodeURIComponent(dn)}`)).json<{
      users: { samAccountName: string; description: string | null }[];
      computers: { name: string; description: string | null }[];
    }>();

  it('give each user’s description', async () => {
    const { users } = await contents(SERVICE_ACCOUNTS);

    expect(users.find((u) => u.samAccountName === 'svc-openaduc')?.description).toBe(
      'OpenADUC sync service account',
    );
  });

  it('give each computer’s description', async () => {
    await api.app.db
      .updateTable('computer_cache_records')
      .set({ description: 'Front desk' })
      .where('name', '=', 'WS01')
      .execute();

    const { computers } = await contents(WORKSTATIONS);

    expect(computers.map((c) => [c.name, c.description]).sort()).toEqual([
      ['WS01', 'Front desk'],
      ['WS02', null],
    ]);
  });
});
