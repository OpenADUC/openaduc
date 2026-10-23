// SPDX-License-Identifier: BUSL-1.1
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down, up } from '../../migrations/20261023000004_group_group_memberships.js';
import { configureDirectory, startApi, type TestApi } from './harness.js';

describe('adding the nested-group memberships table', () => {
  let api: TestApi;
  let db: Knex;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL! });
  });
  afterAll(async () => {
    await db?.destroy();
    await api?.close();
  });

  it('fills it from the groups already in the cache', async () => {
    await down(db);
    await up(db);

    const rows = await db('group_group_memberships as m')
      .join('group_cache_records as g', 'g.object_guid', 'm.group_object_guid')
      .join('group_cache_records as n', 'n.object_guid', 'm.member_group_object_guid')
      .select('g.name as group', 'n.name as member');
    expect(rows).toContainEqual({ group: 'All Staff', member: 'Engineering' });
    expect(rows).toContainEqual({ group: 'Guests', member: 'Domain Guests' });
  });
});
