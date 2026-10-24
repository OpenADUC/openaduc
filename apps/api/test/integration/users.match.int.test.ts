// SPDX-License-Identifier: BUSL-1.1
import type { UserMatchResponse, UserMatchResult } from '@openaduc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

// Matches a pasted list against the cache, so the cache rows stand in for
// what the dev DC can't hold: a separate mail address, Exchange proxy
// addresses and two people with one display name.
describe('POST /api/users/match', () => {
  let api: TestApi;
  let operator: TestClient;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    const cached = await api.app.db
      .selectFrom('user_cache_records')
      .select(['object_guid', 'sam_account_name'])
      .where('provider_id', '=', api.directoryId!)
      .execute();
    for (const r of cached) ids[r.sam_account_name!] = r.object_guid;

    await api.app.db
      .updateTable('user_cache_records')
      .set({
        email: 'D.Diaz@mail.example',
        raw_attributes_json: JSON.stringify({
          proxyAddresses: ['SMTP:D.Diaz@mail.example', 'smtp:dave@old.example', 'X500:/o=x/dave'],
        }),
      })
      .where('object_guid', '=', ids['dave.diaz']!)
      .execute();
    // Other tests rename fixtures in the DC, so set the names this one needs.
    for (const [sam, name] of [
      ['alice.anders', 'Alice Anders'],
      ['bob.baker', 'Bob Baker'],
      ['erin.evans', 'Bob Baker'],
    ] as const) {
      await api.app.db
        .updateTable('user_cache_records')
        .set({ display_name: name })
        .where('object_guid', '=', ids[sam]!)
        .execute();
    }

    operator = api.client();
    await operator.signIn(api, 'oa.operator');
  });
  afterAll(async () => {
    await api?.close();
  });

  async function match(client: TestClient, entries: string[]): Promise<UserMatchResult[]> {
    const res = await client.post('/api/users/match', { entries });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<UserMatchResponse>().results;
  }

  const matched = (r: UserMatchResult | undefined) => (r?.status === 'matched' ? r.user.id : r);

  it('matches each kind of identifier to its user', async () => {
    const results = await match(operator, [
      'alice.anders',
      'OPENADUC\\carol.chen',
      'bob.baker@openaduc.test',
      'd.diaz@mail.example',
      'dave@old.example',
      'Alice Anders',
      'Carol Chen <carol.chen@openaduc.test>',
    ]);

    expect(results.map(matched)).toEqual([
      ids['alice.anders'],
      ids['carol.chen'],
      ids['bob.baker'],
      ids['dave.diaz'],
      ids['dave.diaz'],
      ids['alice.anders'],
      ids['carol.chen'],
    ]);
    expect(results[1]).toMatchObject({
      status: 'matched',
      user: {
        samAccountName: 'carol.chen',
        enabled: false,
        distinguishedName: expect.stringContaining('OU=Contractors'),
      },
    });
  });

  it('lists unmatched and ambiguous entries, once each', async () => {
    const results = await match(operator, [
      'Bob Baker',
      'nobody@example.com',
      '/o=x/dave',
      ' ALICE.ANDERS ',
      'alice.anders',
    ]);

    expect(results).toEqual([
      {
        entry: 'Bob Baker',
        status: 'ambiguous',
        candidates: [
          expect.objectContaining({ id: ids['bob.baker'], department: 'Engineering' }),
          expect.objectContaining({ id: ids['erin.evans'], department: 'Sales' }),
        ],
      },
      { entry: 'nobody@example.com', status: 'unmatched' },
      { entry: '/o=x/dave', status: 'unmatched' },
      expect.objectContaining({ entry: 'ALICE.ANDERS', status: 'matched' }),
    ]);
  });

  it('reads "Last, First" as a name, and a comma list as entries', async () => {
    const results = await match(operator, ['Anders, Alice', 'carol.chen, bob.baker, nobody']);

    expect(results.map((r) => [r.entry, matched(r)])).toEqual([
      ['Anders, Alice', ids['alice.anders']],
      ['carol.chen', ids['carol.chen']],
      ['bob.baker', ids['bob.baker']],
      ['nobody', { entry: 'nobody', status: 'unmatched' }],
    ]);
  });

  it('matches whatever case the entry is in, folded the way the database folds it', async () => {
    await api.app.db
      .updateTable('user_cache_records')
      .set({ display_name: 'İpek Élodie' })
      .where('object_guid', '=', ids['carol.chen']!)
      .execute();

    // JS lowercases İ to two code points; Postgres's lower() may not.
    const results = await match(operator, ['İPEK ÉLODIE']);
    expect(results.map(matched)).toEqual([ids['carol.chen']]);
  });

  it('refuses more entries than one request may match', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => `user${i}`);
    const res = await operator.post('/api/users/match', { entries });
    expect(res.statusCode).toBe(400);
  });

  it('is audited as a search when search auditing is on', async () => {
    await api.app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(true) })
      .where('key', '=', 'audit.search_enabled')
      .execute();
    api.app.services.settings.invalidate('audit.search_enabled');
    await match(operator, ['alice.anders', 'nobody']);

    const row = await api.app.db
      .selectFrom('audit_events')
      .select(['action', 'metadata_json'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      action: 'user.search',
      metadata_json: {
        pastedEntries: 2,
        matched: 1,
        ambiguous: 0,
        unmatched: 1,
        matchedUserIds: [ids['alice.anders']],
      },
    });
  });
});
