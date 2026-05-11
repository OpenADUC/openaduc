// SPDX-License-Identifier: BUSL-1.1
import { markGroupsStale, upsertGroup } from '../../groupCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Full group crawl + stale-mark for unseen rows. Daily reconciliation.
 */
export async function runGroupsFull(ctx: RunnerContext): Promise<RunnerResult> {
  const seen = new Set<string>();
  let count = 0;

  for await (const group of ctx.provider.syncGroups({})) {
    try {
      await upsertGroup(ctx.db, ctx.providerId, group);
      seen.add(group.objectGuid);
      count++;
    } catch (err) {
      ctx.log.warn({ err, guid: group.objectGuid }, 'group upsert failed');
    }
  }

  await markGroupsStale(ctx.db, ctx.providerId, seen);

  return {
    cursor: new Date().toISOString(),
    stats: { groupsSeen: count },
    triggers: ['memberships.rebuild'],
  };
}
