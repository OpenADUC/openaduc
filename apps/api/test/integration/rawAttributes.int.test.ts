// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdministrator,
  configureDirectory,
  DC,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

describe('raw directory attributes', () => {
  let api: TestApi;
  let admin: TestClient;
  let auditor: TestClient;

  beforeAll(async () => {
    // A note the property pages show, and a password-bearing attribute an
    // admin can set but OpenADUC must never pass on.
    await setUserAttribute('alice.anders', 'info', ['Prefers email']);
    await setUserAttribute('alice.anders', 'userPassword', ['Not-for-your-eyes-1']);
    // The directory really holds it, so the checks below aren't vacuous.
    const stored = await asAdministrator((c) =>
      c.search(DC.baseDn, {
        filter: '(sAMAccountName=alice.anders)',
        attributes: ['userPassword'],
      }),
    );
    expect(String(stored.searchEntries[0]?.userPassword)).toContain('Not-for-your-eyes');
    api = await startApi();
    admin = await configureDirectory(api);
    expect((await api.app.services.sync.runOnce(api.directoryId!, 'policies.full')).ok).toBe(true);
    auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
  });
  afterAll(async () => {
    await setUserAttribute('alice.anders', 'info', []);
    await setUserAttribute('alice.anders', 'userPassword', []);
    await api?.close();
  });

  const detailOf = async (client: TestClient, kind: 'users' | 'computers', q: string) => {
    const list = await client.get(`/api/${kind}?q=${q}`);
    const id = list.json<{ rows: { id: string }[] }>().rows[0]!.id;
    const detail = await client.get(`/api/${kind}/${id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json<Record<string, Record<string, unknown>>>();
    return { body: detail.body, detail: (kind === 'users' ? body.user : body.computer)! };
  };
  const firstPolicy = async (client: TestClient) => {
    const list = await client.get('/api/policies/groups');
    const id = list.json<{ policies: { id: string }[] }>().policies[0]!.id;
    return (await client.get(`/api/policies/groups/${id}`)).json<{
      policy: { rawAttributes: unknown };
    }>().policy;
  };

  it('are withheld entirely from a reader without view:raw_attributes', async () => {
    expect((await detailOf(auditor, 'users', 'alice')).detail.rawAttributes).toBeNull();
    expect((await detailOf(auditor, 'computers', 'WS01')).detail.rawAttributes).toBeNull();
    expect((await firstPolicy(auditor)).rawAttributes).toBeNull();
  });

  it('still give that reader the fields the property pages show, as typed fields', async () => {
    const { detail } = await detailOf(auditor, 'users', 'alice');
    expect(detail.info).toBe('Prefers email');
    expect(detail.cn).toBe('Alice Anders');
  });

  it('are returned in full to an admin', async () => {
    const { detail } = await detailOf(admin, 'computers', 'WS01');
    expect(detail.rawAttributes).toHaveProperty('whenCreated');
    expect(await firstPolicy(admin)).toHaveProperty('rawAttributes.displayName');
  });

  it('never include a password-bearing attribute, in a response or in the cache', async () => {
    const { body } = await detailOf(admin, 'users', 'alice');
    expect(body).not.toMatch(/"userPassword"|Not-for-your-eyes/i);
    const cached = await api.app.db
      .selectFrom('user_cache_records')
      .select('raw_attributes_json')
      .where('sam_account_name', '=', 'alice.anders')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(cached.raw_attributes_json)).not.toMatch(/Not-for-your-eyes/);
  });
});
