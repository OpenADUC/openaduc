// SPDX-License-Identifier: BUSL-1.1
import { upsertUser } from '../../userCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Full crawl of every user under the directory's base DN. Reconciles
 * drift that the delta sync might have missed and flags absent users as
 * stale. Expensive — runs daily by default.
 *
 * Triggers `memberships.rebuild` so the membership join table reflects
 * any moves the crawl picked up.
 */
export async function runUsersFull(ctx: RunnerContext): Promise<RunnerResult> {
  const seen = new Set<string>();
  let count = 0;

  for await (const user of ctx.provider.syncUsers({})) {
    try {
      await upsertUser(ctx.db, ctx.providerId, user, { source: 'sync' });
      seen.add(user.objectGuid);
      count++;
    } catch (err) {
      ctx.log.warn({ err, guid: user.objectGuid }, 'user upsert failed');
    }
  }

  // Mark users we didn't see as stale (returned in cache reads with a
  // staleness badge; not deleted — sync_jobs / tombstones owns deletes).
  await markUnseenUsersStale(ctx, seen);

  return {
    cursor: new Date().toISOString(),
    stats: { usersSeen: count, usersStaleScanned: seen.size },
    triggers: ['memberships.rebuild'],
  };
}

async function markUnseenUsersStale(ctx: RunnerContext, seen: Set<string>): Promise<void> {
  const now = new Date().toISOString();
  if (seen.size === 0) {
    await ctx.db
      .updateTable('user_cache_records')
      .set({ stale_at: now })
      .where('provider_id', '=', ctx.providerId)
      .where('stale_at', 'is', null)
      .execute();
    return;
  }
  await ctx.db
    .updateTable('user_cache_records')
    .set({ stale_at: now })
    .where('provider_id', '=', ctx.providerId)
    .where('stale_at', 'is', null)
    .where('object_guid', 'not in', Array.from(seen))
    .execute();
}
