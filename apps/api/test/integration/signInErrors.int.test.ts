// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  DC,
  reseedDirectory,
  setUserAttribute,
  startApi,
  type TestApi,
} from './harness.js';

// accountExpires is a FILETIME: 100 ns ticks since 1601. 0 means never.
const filetime = (d: Date) => String((BigInt(d.getTime()) + 11644473600000n) * 10000n);

describe('sign-in failures look the same whatever the reason', () => {
  let api: TestApi;

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  // A fresh client per attempt: its own source address, so rate limits and
  // per-(IP, user) backoff don't shape the responses.
  const attempt = async (username: string, password: string) => {
    const res = await api.client().post('/api/auth/login', {
      directoryId: api.directoryId,
      username,
      password,
    });
    return { status: res.statusCode, body: res.body };
  };

  it('unknown user, wrong password, locked, disabled, expired and no-role are indistinguishable', async () => {
    await setUserAttribute('alice.anders', 'accountExpires', [
      filetime(new Date(Date.now() - 86_400_000)),
    ]);
    let accountExpired;
    try {
      accountExpired = await attempt('alice.anders', DC.password);
      // The directory refused the bind; alice getting this far and then
      // failing for having no role would prove nothing about expiry.
      const audit = await api.app.db
        .selectFrom('audit_events')
        .select('error_code')
        .where('action', '=', 'auth.login')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      expect(audit.error_code).toBe('invalid_credentials');
    } finally {
      await setUserAttribute('alice.anders', 'accountExpires', ['0']);
    }
    const results = {
      accountExpired,
      unknownUser: await attempt('no.such.user', 'whatever-password'),
      wrongPassword: await attempt('alice.anders', 'not-the-password'),
      locked: await attempt('dave.diaz', DC.password),
      disabled: await attempt('carol.chen', DC.password),
      mustChangePassword: await attempt('erin.evans', DC.password),
      // Correct password, but no OpenADUC role: telling them apart would
      // confirm the password to an anonymous caller.
      noRole: await attempt('bob.baker', DC.password),
    };
    const reference = results.unknownUser;
    expect(reference.status).toBe(401);
    for (const [reason, r] of Object.entries(results)) {
      expect({ reason, ...r }).toEqual({ reason, ...reference });
    }
  });

  it('keeps the specific reason in the audit trail', async () => {
    await attempt('carol.chen', DC.password);
    const row = await api.app.db
      .selectFrom('audit_events')
      .select(['error_code', 'metadata_json'])
      .where('action', '=', 'auth.login')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.error_code).not.toBe('unknown');
    expect(JSON.stringify(row.metadata_json)).toContain('carol.chen');
  });

  it('step-up with a wrong password gets the same generic message', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    const res = await operator.post('/api/auth/step-up', { password: 'not-the-password' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/wrong password|not found/i);
  });

  it('a directory outage reveals no hosts, ports or library errors', async () => {
    await api.app.db
      .updateTable('directory_providers')
      .set({ ldap_urls: ['ldaps://localhost:10637'] })
      .execute();
    const r = await attempt('alice.anders', DC.password);
    expect(r.status).toBe(502);
    expect(r.body).not.toMatch(/localhost|10637|ECONN|127\.0\.0\.1|::1/);
  });
});
