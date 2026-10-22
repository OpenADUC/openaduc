// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureDirectory,
  readDirectoryUser,
  reseedDirectory,
  sambaTool,
  startApi,
  type TestApi,
} from './harness.js';

describe('locked status', () => {
  let api: TestApi;

  const daveLocked = async () =>
    (
      await api.app.db
        .selectFrom('user_cache_records')
        .select('locked')
        .where('sam_account_name', '=', 'dave.diaz')
        .executeTakeFirstOrThrow()
    ).locked;
  const run = async (task: 'users.locked' | 'users.full') =>
    expect((await api.app.services.sync.runOnce(api.directoryId!, task)).ok).toBe(true);

  beforeAll(async () => {
    reseedDirectory(); // Dave locked, lockout duration 0 (until an admin unlocks)
    api = await startApi();
    await configureDirectory(api);
  });
  afterAll(async () => {
    reseedDirectory(); // restores the lockout duration
    await api?.close();
  });

  it('stays locked while the lockout has no duration', async () => {
    await run('users.locked');
    expect(await daveLocked()).toBe(true);
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
