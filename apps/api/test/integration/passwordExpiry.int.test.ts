// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  configureDirectory,
  reseedDirectory,
  sambaTool,
  startApi,
  type TestApi,
} from './harness.js';

const DAY = 86_400_000;

describe('password expiry', () => {
  let api: TestApi;

  beforeAll(async () => {
    reseedDirectory();
    // Short enough that the fixtures' fresh passwords fall inside the
    // notifier's 14-day window.
    sambaTool('domain', 'passwordsettings', 'set', '--max-pwd-age=10');
    api = await startApi();
    await configureDirectory(api); // runs users.full
  });
  afterAll(async () => {
    sambaTool('domain', 'passwordsettings', 'set', '--max-pwd-age=42');
    await api?.close();
  });

  const cached = (sam: string) =>
    api.app.db
      .selectFrom('user_cache_records')
      .selectAll()
      .where('sam_account_name', '=', sam)
      .executeTakeFirstOrThrow();

  it('is stored by sync from the domain policy', async () => {
    const alice = await cached('alice.anders');
    expect(alice.password_expires_at).not.toBeNull();
    const lifetime =
      new Date(alice.password_expires_at!).getTime() -
      new Date(alice.password_last_set_at!).getTime();
    expect(Math.round(lifetime / DAY)).toBe(10);
  });

  it('flags accounts that must change their password at next logon', async () => {
    expect((await cached('erin.evans')).password_must_change).toBe(true);
    expect((await cached('alice.anders')).password_must_change).toBe(false);
  });

  it('lists must-change accounts among the dashboard issues', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    const res = await operator.get('/api/users?issues=true&pageSize=100');
    const rows = res.json<{ rows: { samAccountName: string; passwordMustChange: boolean }[] }>()
      .rows;
    expect(rows.find((r) => r.samAccountName === 'erin.evans')?.passwordMustChange).toBe(true);
  });

  it('sorts by expiry', async () => {
    const operator = api.client();
    await operator.signIn(api, 'oa.operator');
    const res = await operator.get('/api/users?sort=passwordExpiresAt&sortDir=asc&pageSize=100');
    const dates = res
      .json<{ rows: { passwordExpiresAt: string | null }[] }>()
      .rows.map((r) => r.passwordExpiresAt)
      .filter((d): d is string => d !== null);
    expect(dates.length).toBeGreaterThan(3);
    expect([...dates].sort()).toEqual(dates);
  });

  it('the expiry notifier picks up the expiring accounts', async () => {
    const { runEntraPasswordExpiryNotify } =
      await import('../../src/services/syncTasks/runners/entraPasswordExpiryNotify.js');
    const sendAdminMessage = vi.fn(async () => ({ ok: true as const }));
    // The notifier reads only the fields given below; `as never` stands in
    // for the rest of the provider and Entra runtime it never touches.
    const result = await runEntraPasswordExpiryNotify({
      db: api.app.db,
      providerId: api.directoryId!,
      log: api.app.log,
      lastCursor: null,
      intervalMinutes: 1440,
      lastSuccessfulRunAt: null,
      provider: undefined as never,
      entra: {
        integration: {
          features: { passwordExpiryNotifications: true, teamsAdminWebhook: true },
          hasTeamsWebhookUrl: true,
        },
        teams: { sendAdminMessage },
      } as never,
    });

    expect(result.stats?.candidates).toBeGreaterThan(0);
    const titles = sendAdminMessage.mock.calls.map((c) => (c as unknown[])[1]);
    expect(JSON.stringify(titles)).toContain('Alice');
  });

  it('honours a fine-grained policy that never expires, not the domain maximum', async () => {
    sambaTool(
      'domain',
      'passwordsettings',
      'pso',
      'create',
      'oa-never-expires',
      '1',
      '--max-pwd-age=0',
    );
    sambaTool('domain', 'passwordsettings', 'pso', 'apply', 'oa-never-expires', 'bob.baker');
    try {
      expect((await api.app.services.sync.runOnce(api.directoryId!, 'users.full')).ok).toBe(true);
      const bob = await cached('bob.baker');
      expect(bob.password_expiry_computed).toBe(true);
      expect(bob.password_expires_at).toBeNull();

      const operator = api.client();
      await operator.signIn(api, 'oa.operator');
      const res = await operator.get('/api/users?q=bob.baker');
      expect(res.json<{ rows: { passwordExpiresAt: string | null }[] }>().rows[0]).toMatchObject({
        passwordExpiresAt: null,
      });
    } finally {
      sambaTool('domain', 'passwordsettings', 'pso', 'delete', 'oa-never-expires');
    }
  });
});
