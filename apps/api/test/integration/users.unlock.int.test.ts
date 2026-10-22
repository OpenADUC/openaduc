// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
} from './harness.js';

const isLocked = async (sam: string) => {
  const entry = await readDirectoryUser(sam, ['lockoutTime']);
  return Number(entry?.lockoutTime ?? 0) > 0;
};

describe('unlocking a locked-out user', () => {
  let api: TestApi;

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('an operator unlocks the account in AD, the cache and the audit trail', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();

    const search = await operator.get('/api/users?q=dave.diaz');
    expect(search.statusCode).toBe(200);
    const dave = search.json<{ rows: { id: string; locked: boolean }[] }>().rows[0]!;
    expect(dave.locked).toBe(true);
    expect(await isLocked('dave.diaz')).toBe(true);

    const res = await operator.post(`/api/users/${dave.id}/unlock`);

    expect(res.statusCode).toBe(200);
    expect(await isLocked('dave.diaz')).toBe(false);

    const cached = await api.app.db
      .selectFrom('user_cache_records')
      .select('locked')
      .where('object_guid', '=', dave.id)
      .executeTakeFirstOrThrow();
    expect(cached.locked).toBe(false);

    const audit = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'actor_display_name'])
      .where('action', '=', 'user.unlock')
      .where('target_id', '=', dave.id)
      .execute();
    expect(audit).toEqual([{ result: 'success', actor_display_name: 'OpenADUC Operator' }]);
  });
});
