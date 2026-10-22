// SPDX-License-Identifier: BUSL-1.1
// Requests arrive the way they do in production: from the nginx container,
// which appends the real peer address to whatever X-Forwarded-For the
// client sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi } from './harness.js';

const REAL_CLIENT = '203.0.113.9';

describe('the client IP comes from the proxy, not from the client', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  const viaProxy = (spoofed: string) => {
    const client = api.client(); // its own socket address plays nginx
    client.headers['x-forwarded-for'] = `${spoofed}, ${REAL_CLIENT}`;
    return client;
  };

  it('changing X-Forwarded-For per request does not escape the login rate limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      // Each attempt also comes through a different nginx socket, like a
      // multi-worker proxy would.
      const res = await viaProxy(`198.51.100.${i}`).post('/api/auth/login', {
        directoryId: api.directoryId,
        username: 'alice.anders',
        password: 'not-the-password',
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toContain(429);
  });

  it('audit rows record the real client address', async () => {
    await viaProxy('198.51.100.200').post('/api/auth/login', {
      directoryId: api.directoryId,
      username: 'bob.baker',
      password: 'not-the-password',
    });
    const row = await api.app.db
      .selectFrom('audit_events')
      .select('source_ip')
      .where('action', '=', 'auth.login')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.source_ip).toBe(REAL_CLIENT);
  });
});
