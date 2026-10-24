// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  startApi,
  type TestApi,
} from './harness.js';

describe('editing a user’s attributes', () => {
  let api: TestApi;

  beforeAll(async () => {
    reseedDirectory();
    api = await startApi();
    await configureDirectory(api);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('an operator sets and then clears the work street address', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    const search = await operator.get('/api/users?q=bob.baker');
    const bob = search.json<{ rows: { id: string }[] }>().rows[0]!;
    const street = '1 Main Street\nSuite 200';

    const set = await operator.patch(`/api/users/${bob.id}`, {
      patch: { streetAddress: street },
    });
    expect(set.statusCode).toBe(200);
    expect((await readDirectoryUser('bob.baker', ['streetAddress']))?.streetAddress).toBe(street);
    const detail = await operator.get(`/api/users/${bob.id}`);
    expect(detail.json<{ user: { streetAddress: string | null } }>().user.streetAddress).toBe(
      street,
    );

    const cleared = await operator.patch(`/api/users/${bob.id}`, {
      patch: { streetAddress: null },
    });
    expect(cleared.statusCode).toBe(200);
    // ldapts returns a requested attribute the entry lacks as [].
    expect((await readDirectoryUser('bob.baker', ['streetAddress']))?.streetAddress).toEqual([]);

    const audit = await api.app.db
      .selectFrom('audit_events')
      .select('result')
      .where('action', '=', 'user.update')
      .where('target_id', '=', bob.id)
      .execute();
    expect(audit).toEqual([{ result: 'success' }, { result: 'success' }]);
  });

  it('audits the values an edit changed, before and after', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    const search = await operator.get('/api/users?q=alice.anders');
    const alice = search.json<{ rows: { id: string }[] }>().rows[0]!;

    await operator.patch(`/api/users/${alice.id}`, { patch: { company: 'Initech' } });
    const res = await operator.patch(`/api/users/${alice.id}`, { patch: { company: 'Globex' } });

    expect(res.statusCode).toBe(200);
    const [event] = await api.app.db
      .selectFrom('audit_events')
      .select(['before_json', 'after_json', 'metadata_json'])
      .where('action', '=', 'user.update')
      .where('target_id', '=', alice.id)
      .orderBy('id', 'desc')
      .limit(1)
      .execute();
    expect(event).toMatchObject({
      before_json: { company: 'Initech' },
      after_json: { company: 'Globex' },
      metadata_json: { fields: ['company'] },
    });
  });
});
