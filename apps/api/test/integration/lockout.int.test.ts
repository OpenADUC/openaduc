// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  DC,
  readDirectoryUser,
  reseedDirectory,
  sambaTool,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

describe('locked status', () => {
  let api: TestApi;
  let admin: TestClient;

  const daveLocked = async () =>
    (
      await api.app.db
        .selectFrom('user_cache_records')
        .select('locked')
        .where('sam_account_name', '=', 'dave.diaz')
        .executeTakeFirstOrThrow()
    ).locked;
  const daveId = async () =>
    (await admin.get('/api/users?q=dave.diaz')).json<{ rows: { id: string }[] }>().rows[0]!.id;
  const run = async (task: 'users.locked' | 'users.full') =>
    expect((await api.app.services.sync.runOnce(api.directoryId!, task)).ok).toBe(true);

  beforeAll(async () => {
    reseedDirectory(); // Dave locked, lockout duration 0 (until an admin unlocks)
    api = await startApi();
    admin = await configureDirectory(api);
  });
  afterAll(async () => {
    reseedDirectory(); // restores the lockout duration
    await api?.close();
  });

  it('stays locked while the lockout has no duration', async () => {
    await run('users.locked');
    expect(await daveLocked()).toBe(true);
  });

  it('says a lockout with no duration lasts until someone unlocks the account', async () => {
    const res = await admin.get(`/api/users/${await daveId()}`);
    expect(res.statusCode).toBe(200);
    const { user } = res.json<{ user: Record<string, unknown> }>();
    expect(user).toMatchObject({
      locked: true,
      autoUnlockAt: null,
      lockedUntilUnlocked: true,
      badPasswordCount: 5,
    });
    expect(user.lockedAt).toEqual(expect.any(String));
  });

  it('sorts by status the way the user page ranks: disabled, locked, must change', async () => {
    const res = await admin.get('/api/users?sort=status&pageSize=500');
    const names = res
      .json<{ rows: { samAccountName: string }[] }>()
      .rows.map((r) => r.samAccountName);
    const at = (sam: string) => names.indexOf(sam);
    expect(at('carol.chen')).toBeGreaterThanOrEqual(0);
    expect(at('carol.chen')).toBeLessThan(at('dave.diaz'));
    expect(at('dave.diaz')).toBeLessThan(at('erin.evans'));
  });

  it('takes the lockout end from a fine-grained password policy, or admits it can’t', async () => {
    const PSO = 'oa-lockout-test';
    const psoDn = `CN=${PSO},CN=Password Settings Container,CN=System,${DC.baseDn}`;
    const daveLockout = async () =>
      (await admin.get(`/api/users/${await daveId()}`)).json<{
        user: { lockedAt: string; autoUnlockAt: string | null; lockedUntilUnlocked: boolean };
      }>().user;
    // The domain keeps lockouts until someone unlocks them; the PSO lasts 600 minutes.
    sambaTool(
      ...['domain', 'passwordsettings', 'pso', 'create', PSO, '1'],
      ...['--account-lockout-duration=600', '--account-lockout-threshold=5'],
      '--reset-account-lockout-after=600',
    );
    try {
      sambaTool('domain', 'passwordsettings', 'pso', 'apply', PSO, 'dave.diaz');

      // As in AD, only Domain Admins can read a PSO's settings by default.
      expect(await daveLockout()).toMatchObject({ autoUnlockAt: null, lockedUntilUnlocked: false });

      const svcSid = /objectSid: (\S+)/.exec(
        sambaTool('user', 'show', DC.serviceAccount, '--attributes=objectSid'),
      )![1];
      sambaTool('dsacl', 'set', `--objectdn=${psoDn}`, `--sddl=(A;;RPLCLORC;;;${svcSid})`);
      const readable = await daveLockout();
      expect(readable.lockedUntilUnlocked).toBe(false);
      expect(Date.parse(readable.autoUnlockAt!) - Date.parse(readable.lockedAt)).toBe(600 * 60_000);
    } finally {
      sambaTool('domain', 'passwordsettings', 'pso', 'delete', PSO);
    }
  });

  it('clears once the lockout duration has passed, though lockoutTime is still set', async () => {
    // 1 minute is the shortest duration AD allows; wait until AD itself
    // says Dave's lockout has lapsed (lockoutTime stays non-zero).
    sambaTool('domain', 'passwordsettings', 'set', '--account-lockout-duration=1');
    for (let waited = 0; ; waited += 2000) {
      const dave = await readDirectoryUser('dave.diaz', ['msDS-User-Account-Control-Computed']);
      if ((Number(dave?.['msDS-User-Account-Control-Computed']) & 0x10) === 0) break;
      if (waited > 90_000) throw new Error('lockout never lapsed');
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(
      Number((await readDirectoryUser('dave.diaz', ['lockoutTime']))?.lockoutTime),
    ).toBeGreaterThan(0);

    await run('users.locked');
    expect(await daveLocked()).toBe(false);

    await run('users.full');
    expect(await daveLocked()).toBe(false);
  }, 120_000);
});
