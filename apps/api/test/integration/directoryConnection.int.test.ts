// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, startApi, type TestApi, type TestClient } from './harness.js';

describe('changing how a directory connects', () => {
  let api: TestApi;
  let admin: TestClient;

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api);
  });
  afterEach(async () => {
    await api.app.db
      .updateTable('directory_providers')
      .set({ ldap_urls: [DC.ldapsUrl], tls_mode: 'ldaps' })
      .execute();
  });
  afterAll(async () => {
    await api?.close();
  });

  const stored = () =>
    api.app.db
      .selectFrom('directory_providers')
      .select(['ldap_urls', 'tls_mode', 'config_json'])
      .executeTakeFirstOrThrow();
  const patch = (body: Record<string, unknown>) =>
    admin.patch(`/api/directories/${api.directoryId}`, body);

  it('needs the service-account password re-entered', async () => {
    const res = await patch({ ldapUrls: [DC.ldapUrl], tlsMode: 'starttls' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/password/i);
    expect((await stored()).ldap_urls).toEqual([DC.ldapsUrl]);
  });

  it('is not saved when the new settings fail to bind', async () => {
    const res = await patch({
      ldapUrls: ['ldaps://localhost:10637'],
      syncBindPassword: DC.password,
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await stored()).ldap_urls).toEqual([DC.ldapsUrl]);
  });

  it('turning off certificate checks also needs the password and a bind', async () => {
    const res = await patch({ tlsRejectUnauthorized: false });
    expect(res.statusCode).toBe(400);
  });

  it('is saved after a successful bind with the new settings, and audited as verified', async () => {
    const res = await patch({
      ldapUrls: [DC.ldapUrl],
      tlsMode: 'starttls',
      syncBindPassword: DC.password,
    });

    expect(res.statusCode).toBe(200);
    expect(await stored()).toMatchObject({ ldap_urls: [DC.ldapUrl], tls_mode: 'starttls' });
    const audit = await api.app.db
      .selectFrom('audit_events')
      .select('metadata_json')
      .where('action', '=', 'directory.update')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.metadata_json).toMatchObject({ connectionVerified: true });
  });

  it('other edits still save without the password', async () => {
    const res = await patch({ displayName: 'Test domain' });
    expect(res.statusCode).toBe(200);
  });
});

describe('testing the stored service-account credentials', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  it('requires step-up', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    const res = await admin.post(`/api/directories/${api.directoryId}/test-sync-bind`, {
      syncBindUpn: `${DC.serviceAccount}@${DC.domain}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });

  it('only sends the stored password as the stored account', async () => {
    const admin = api.client();
    await admin.signIn(api, 'oa.admin');
    await admin.stepUp();
    const res = await admin.post(`/api/directories/${api.directoryId}/test-sync-bind`, {
      syncBindUpn: `oa.admin@${DC.domain}`,
    });
    expect(res.statusCode).toBe(400);
  });
});
