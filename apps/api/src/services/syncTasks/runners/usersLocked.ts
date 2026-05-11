// SPDX-License-Identifier: BUSL-1.1
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * High-frequency lockout poller. Runs every 5 min by default.
 *
 * Pulls only users with a non-zero `lockoutTime`, patches the lockout
 * fields (`locked`, `live_refreshed_at`) on matching cache rows, and
 * clears the `locked` flag on any cache row that *was* locked but is no
 * longer in the result set (an admin elsewhere unlocked them, or AD
 * auto-cleared the lockout).
 *
 * Does NOT change `synced_at` or `stale_at` — this is a partial probe,
 * not a full sync. Other fields on those users are left to the next
 * delta or full pass.
 */
export async function runUsersLocked(ctx: RunnerContext): Promise<RunnerResult> {
  const lockedUsers = await ctx.provider.searchUsers({
    locked: true,
    pageSize: 500,
  });

  const seenGuids = new Set<string>();
  const now = new Date().toISOString();
  for (const user of lockedUsers) {
    seenGuids.add(user.objectGuid);
    try {
      await ctx.db
        .updateTable('user_cache_records')
        .set({ locked: true, live_refreshed_at: now })
        .where('provider_id', '=', ctx.providerId)
        .where('object_guid', '=', user.objectGuid)
        .execute();
    } catch (err) {
      ctx.log.warn({ err, guid: user.objectGuid }, 'lockout patch failed');
    }
  }

  // Anyone we previously had marked locked who isn't in this result is
  // no longer locked. Clear the flag in a single statement.
  let cleared = 0;
  if (seenGuids.size === 0) {
    const res = await ctx.db
      .updateTable('user_cache_records')
      .set({ locked: false, live_refreshed_at: now })
      .where('provider_id', '=', ctx.providerId)
      .where('locked', '=', true)
      .executeTakeFirst();
    cleared = Number(res.numUpdatedRows ?? 0n);
  } else {
    const res = await ctx.db
      .updateTable('user_cache_records')
      .set({ locked: false, live_refreshed_at: now })
      .where('provider_id', '=', ctx.providerId)
      .where('locked', '=', true)
      .where('object_guid', 'not in', Array.from(seenGuids))
      .executeTakeFirst();
    cleared = Number(res.numUpdatedRows ?? 0n);
  }

  return {
    stats: { lockedCount: lockedUsers.length, clearedCount: cleared },
  };
}
