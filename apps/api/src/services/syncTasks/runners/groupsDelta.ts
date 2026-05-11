// SPDX-License-Identifier: BUSL-1.1
import { upsertGroup } from '../../groupCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

const OVERLAP_MS = 5 * 60_000;

/**
 * Incremental group sync. Same shape as users.delta — pulls
 * `whenChanged>=lastSuccess - 5m` and upserts. Picks up new groups,
 * renames, description / type changes, and (importantly) membership
 * churn since `memberOf` lives on the user side but `member` lives on
 * the group side.
 *
 * Triggers `memberships.rebuild` whenever it observed any change.
 */
export async function runGroupsDelta(ctx: RunnerContext): Promise<RunnerResult> {
  const since = ctx.lastSuccessfulRunAt
    ? new Date(ctx.lastSuccessfulRunAt.getTime() - OVERLAP_MS)
    : undefined;

  let count = 0;
  for await (const group of ctx.provider.syncGroups(since ? { modifiedSince: since } : {})) {
    try {
      await upsertGroup(ctx.db, ctx.providerId, group);
      count++;
    } catch (err) {
      ctx.log.warn({ err, guid: group.objectGuid }, 'group upsert failed');
    }
  }

  return {
    cursor: new Date().toISOString(),
    stats: {
      groupsSeen: count,
      modifiedSince: since?.toISOString() ?? null,
    },
    triggers: count > 0 ? ['memberships.rebuild'] : [],
  };
}
