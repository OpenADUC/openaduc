// SPDX-License-Identifier: BUSL-1.1
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesOfRoles, ROLE_CAPABILITIES } from '@openaduc/shared';
import { down, up } from '../../migrations/20261028000003_admin_session_roles.js';
import { hashToken } from '../../src/lib/crypto.js';
import { configureDirectory, DC, startApi, type TestApi } from './harness.js';

// A session keeps the roles AD gave at sign-in; what they allow comes from
// the running build, so a release that adds capabilities needs no sign-out.
describe('a signed-in session’s capabilities', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    await api?.close();
  });

  const capabilitiesOf = async (client: ReturnType<TestApi['client']>) =>
    (await client.get('/api/auth/me')).json<{ actor: { capabilities: string[] } }>().actor
      .capabilities;

  it('come from the roles stored at sign-in', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');

    const row = await api.app.db
      .selectFrom('admin_sessions')
      .select('roles_json')
      .where('actor_username', '=', `oa.operator@${DC.domain}`)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.roles_json).toEqual(['operator']);
    expect((await capabilitiesOf(operator)).sort()).toEqual([...ROLE_CAPABILITIES.operator].sort());
  });

  it('are worked out on each request, not kept from sign-in', async () => {
    const auditor = api.client();
    await auditor.signIn(api, 'oa.auditor');
    expect((await auditor.get('/api/users/export.csv')).statusCode).toBe(403);

    await api.app.db
      .updateTable('admin_sessions')
      .set({ roles_json: JSON.stringify(['auditor', 'operator']) })
      .where('actor_username', '=', `oa.auditor@${DC.domain}`)
      .where('revoked_at', 'is', null)
      .execute();

    expect((await capabilitiesOf(auditor)).sort()).toEqual(
      capabilitiesOfRoles(['auditor', 'operator']).sort(),
    );
    expect((await auditor.get('/api/users/export.csv')).statusCode).toBe(200);
  });
});

describe('migrating sessions from a capability snapshot to roles', () => {
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

  it('keeps open sessions signed in with the roles their snapshot implies', async () => {
    await down(db);
    const snapshots: Record<string, string[]> = {
      admin: ['read:user', 'write:user.unlock', 'view:audit', 'configure:security'],
      operator: ['read:user', 'write:user.unlock'],
      auditor: ['read:user', 'view:audit'],
      both: ['read:user', 'write:user.unlock', 'view:audit'],
      none: ['read:user'],
    };
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db('admin_sessions').insert(
      Object.entries(snapshots).map(([name, caps]) => ({
        token_hash: hashToken(`migrated-${name}`),
        directory_id: api.directoryId,
        actor_user_id: name,
        capabilities_json: JSON.stringify(caps),
        expires_at: expiresAt,
      })),
    );

    await up(db);

    const rolesOf = async (name: string) =>
      (await api.app.services.sessions.resolve(`migrated-${name}`))?.roles ?? null;
    expect(await rolesOf('admin')).toEqual(['admin']);
    expect(await rolesOf('operator')).toEqual(['operator']);
    expect(await rolesOf('auditor')).toEqual(['auditor']);
    expect(await rolesOf('both')).toEqual(['operator', 'auditor']);
    expect(await rolesOf('none')).toBeNull();
    const admin = await api.app.services.sessions.resolve('migrated-admin');
    expect(admin?.capabilities).toEqual(capabilitiesOfRoles(['admin']));
  });
});
