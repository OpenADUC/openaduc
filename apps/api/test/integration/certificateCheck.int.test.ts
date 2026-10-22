// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, startApi, type TestApi } from './harness.js';

const setupBody = (tlsRejectUnauthorized?: boolean) => ({
  domain: DC.domain,
  baseDn: DC.baseDn,
  ldapUrls: [DC.ldapsUrl],
  tlsMode: 'ldaps',
  adminUsername: 'oa.admin',
  adminPassword: DC.password,
  ...(tlsRejectUnauthorized === undefined ? {} : { tlsRejectUnauthorized }),
});

describe('setup against a DC whose certificate this server does not trust', () => {
  let api: TestApi;

  beforeAll(async () => {
    // No CA configured, and the default from .env.example (checks off) not
    // in play: what a fresh production install looks like.
    api = await startApi({ env: { AD_TLS_CA_PATH: '', AD_TLS_REJECT_UNAUTHORIZED: '1' } });
  });
  afterAll(async () => {
    await api?.close();
  });

  it('fails with an explanation of the two ways forward', async () => {
    const res = await api.client().post('/api/setup/initialize', setupBody(true));

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/certificate/i);
    expect(res.body).toMatch(/AD_TLS_CA_PATH/);
  });
});

describe('a directory with certificate checks off', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('is flagged in the directory list', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    const list = async () =>
      (await admin.get('/api/directories')).json<{
        directories: { certificateCheckOff: boolean }[];
      }>().directories[0];

    expect((await list())?.certificateCheckOff).toBe(false);
    await api.app.db
      .updateTable('directory_providers')
      .set({ config_json: JSON.stringify({ tlsRejectUnauthorized: false }) })
      .execute();
    expect((await list())?.certificateCheckOff).toBe(true);
  });
});
