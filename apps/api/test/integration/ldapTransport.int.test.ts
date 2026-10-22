// SPDX-License-Identifier: BUSL-1.1
// The dev DC refuses simple binds over unencrypted LDAP ("Transport
// encryption required"), so a successful bind on its ldap:// port proves
// StartTLS ran before it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, DC, startApi, type TestApi, type TestClient } from './harness.js';

describe('setup over StartTLS', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('upgrades ldap:// before binding, so setup, sync and sign-in work', async () => {
    await configureDirectory(api, { ldapUrls: [DC.ldapUrl], tlsMode: 'starttls' });

    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    const users = await operator.get('/api/users?q=alice');
    expect(users.json<{ rows: { samAccountName: string }[] }>().rows[0]?.samAccountName).toBe(
      'alice.anders',
    );
  });
});

describe('URLs that contradict the TLS mode', () => {
  let api: TestApi;
  let admin: TestClient;

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('setup refuses an ldap:// URL in LDAPS mode before contacting the DC', async () => {
    const res = await api.client().post('/api/setup/initialize', {
      domain: DC.domain,
      baseDn: DC.baseDn,
      ldapUrls: [DC.ldapUrl],
      tlsMode: 'ldaps',
      adminUsername: 'oa.admin',
      adminPassword: DC.password,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(DC.ldapUrl);
    const status = await api.client().get('/api/setup/status');
    expect(status.json<{ configured: boolean }>().configured).toBe(false);
  });

  describe('once a directory exists', () => {
    beforeAll(async () => {
      admin = await configureDirectory(api);
    });
    afterEach(async () => {
      // Put the directory back to its working LDAPS settings.
      await api.app.db
        .updateTable('directory_providers')
        .set({ ldap_urls: [DC.ldapsUrl], tls_mode: 'ldaps' })
        .execute();
    });

    it('editing it to ldap:// under LDAPS is rejected', async () => {
      const res = await admin.patch(`/api/directories/${api.directoryId}`, {
        ldapUrls: [DC.ldapUrl],
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(DC.ldapUrl);
    });

    it('switching the mode alone is checked against the stored URLs', async () => {
      const res = await admin.patch(`/api/directories/${api.directoryId}`, { tlsMode: 'starttls' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(DC.ldapsUrl);
    });

    it('unencrypted LDAP is not accepted', async () => {
      const res = await admin.patch(`/api/directories/${api.directoryId}`, {
        ldapUrls: [DC.ldapUrl],
        tlsMode: 'plain',
      });
      expect(res.statusCode).toBe(400);
    });

    it('adding a second directory with a mismatched URL is rejected', async () => {
      const res = await admin.post('/api/directories', {
        name: 'second',
        domain: DC.domain,
        baseDn: DC.baseDn,
        ldapUrls: [DC.ldapUrl],
        tlsMode: 'ldaps',
        adminUsername: 'oa.admin',
        adminPassword: DC.password,
      });
      expect(res.statusCode).toBe(400);
    });

    it('a stored ldap:// URL under LDAPS keeps connecting with TLS and is flagged', async () => {
      // A row saved before URLs were validated, pointing ldap:// at the
      // LDAPS port. It has always worked over TLS and must keep working.
      const ldapSchemeOnTlsPort = DC.ldapsUrl.replace('ldaps://', 'ldap://');
      await api.app.db
        .updateTable('directory_providers')
        .set({ ldap_urls: [ldapSchemeOnTlsPort] })
        .execute();

      await api.client().signIn(api, 'oa.operator');

      const list = await admin.get('/api/directories');
      const [dir] = list.json<{ directories: { transportProblem: string | null }[] }>().directories;
      expect(dir?.transportProblem).toContain(ldapSchemeOnTlsPort);
    });
  });
});
