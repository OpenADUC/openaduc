// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  readDirectoryUser,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const NEVER = '9223372036854775807';
const toFiletime = (iso: string) =>
  ((BigInt(Date.parse(iso)) + 11644473600000n) * 10000n).toString();

describe('setting when a user’s account expires', () => {
  let api: TestApi;
  let operator: TestClient;
  let bob: string;

  const accountExpires = async () =>
    String((await readDirectoryUser('bob.baker', ['accountExpires']))?.accountExpires);
  const cachedExpiry = async () =>
    (
      await api.app.db
        .selectFrom('user_cache_records')
        .select('account_expires_at')
        .where('object_guid', '=', bob)
        .executeTakeFirstOrThrow()
    ).account_expires_at;

  beforeAll(async () => {
    await setUserAttribute('bob.baker', 'accountExpires', [NEVER]);
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    bob = (await operator.get('/api/users?q=bob.baker')).json<{ rows: { id: string }[] }>().rows[0]!
      .id;
  });

  afterAll(async () => {
    await api?.close();
    await setUserAttribute('bob.baker', 'accountExpires', [NEVER]);
  });

  it('sets the date in AD, the cache and the audit trail, then clears it', async () => {
    const expiresAt = '2031-03-01T05:00:00.000Z';

    const set = await operator.post(`/api/users/${bob}/account-expiry`, { expiresAt });
    expect(set.statusCode).toBe(200);
    expect(await accountExpires()).toBe(toFiletime(expiresAt));
    expect((await cachedExpiry())?.toISOString()).toBe(expiresAt);

    const cleared = await operator.post(`/api/users/${bob}/account-expiry`, { expiresAt: null });
    expect(cleared.statusCode).toBe(200);
    expect(await accountExpires()).toBe(NEVER);
    expect(await cachedExpiry()).toBeNull();

    const audit = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'before_json', 'after_json'])
      .where('action', '=', 'user.accountExpiry.set')
      .where('target_id', '=', bob)
      .orderBy('id')
      .execute();
    expect(audit).toEqual([
      {
        result: 'success',
        before_json: { accountExpiresAt: null },
        after_json: { accountExpiresAt: expiresAt },
      },
      {
        result: 'success',
        before_json: { accountExpiresAt: expiresAt },
        after_json: { accountExpiresAt: null },
      },
    ]);
  });

  it('refuses an auditor, and an operator who hasn’t stepped up', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    expect(
      (await auditor.post(`/api/users/${bob}/account-expiry`, { expiresAt: null })).statusCode,
    ).toBe(403);

    const notElevated = api.client();
    await notElevated.signIn(api, 'oa.operator');
    const res = await notElevated.post(`/api/users/${bob}/account-expiry`, { expiresAt: null });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });

  it('refuses a date that isn’t one', async () => {
    const res = await operator.post(`/api/users/${bob}/account-expiry`, { expiresAt: 'soon' });
    expect(res.statusCode).toBe(400);
  });
});
