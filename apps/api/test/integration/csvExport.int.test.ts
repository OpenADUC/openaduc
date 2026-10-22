// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, setUserAttribute, startApi, type TestApi } from './harness.js';

describe('user CSV export', () => {
  let api: TestApi;

  beforeAll(async () => {
    // A lower-privileged editor could set this.
    await setUserAttribute('bob.baker', 'department', ['=HYPERLINK("http://evil.example","x")']);
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await setUserAttribute('bob.baker', 'department', ['Engineering']);
    await api?.close();
  });

  it('exports formula-like values as text', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    const res = await operator.get('/api/users/export.csv');

    expect(res.statusCode).toBe(200);
    const bob = res.body.split('\n').find((line) => line.includes('bob.baker'))!;
    expect(bob).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
  });
});
