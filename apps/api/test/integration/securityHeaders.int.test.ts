// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './harness.js';

describe('API security headers', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('enforces the content security policy rather than only reporting it', async () => {
    const res = await api.client().get('/health/live');

    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy-report-only']).toBeUndefined();
  });
});
