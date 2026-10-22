// SPDX-License-Identifier: BUSL-1.1
import { upsertGroup } from '../../groupCache.js';
import { cachedMembersOf, upsertUser } from '../../userCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

const OVERLAP_MS = 5 * 60_000;

/**
 * Incremental group sync. Same shape as users.delta — pulls
 * `whenChanged>=lastSuccess - 5m` and upserts. Picks up new groups,
 * renames, description / type changes and membership churn.
 *
 * Memberships are rebuilt from users' `memberOf`, and adding someone to a
 * group changes the group's whenChanged but not the user's, so users.delta
 * never sees it. For each changed group, re-read its current members and
 * the users the cache still lists as members, so their `memberOf` is fresh
 * before the rebuild.
 *
 * Triggers `memberships.rebuild` whenever it observed any change.
 */
export async function runGroupsDelta(ctx: RunnerContext): Promise<RunnerResult> {
  const since = ctx.lastSuccessfulRunAt
    ? new Date(ctx.lastSuccessfulRunAt.getTime() - OVERLAP_MS)
    : undefined;

  const changedDns: string[] = [];
  for await (const group of ctx.provider.syncGroups(since ? { modifiedSince: since } : {})) {
    try {
      await upsertGroup(ctx.db, ctx.providerId, group);
      changedDns.push(group.distinguishedName);
    } catch (err) {
      ctx.log.warn({ err, guid: group.objectGuid }, 'group upsert failed');
    }
  }

  // Without `since` this was a full crawl; users.full covers memberships.
  let membersRefreshed = 0;
  if (since) {
    for (const dn of changedDns) membersRefreshed += await refreshMembers(ctx, dn);
  }

  return {
    cursor: new Date().toISOString(),
    stats: {
      groupsSeen: changedDns.length,
      membersRefreshed,
      modifiedSince: since?.toISOString() ?? null,
    },
    triggers: changedDns.length > 0 ? ['memberships.rebuild'] : [],
  };
}

async function refreshMembers(ctx: RunnerContext, groupDn: string): Promise<number> {
  const refreshed = new Set<string>();
  for await (const user of ctx.provider.syncGroupMembers(groupDn)) {
    try {
      await upsertUser(ctx.db, ctx.providerId, user, { source: 'sync' });
      refreshed.add(user.objectGuid);
    } catch (err) {
      ctx.log.warn({ err, guid: user.objectGuid }, 'group member upsert failed');
    }
  }

  // Cached members no longer in the group: re-read them so their memberOf
  // drops it.
  const cachedMembers = await cachedMembersOf(ctx.db, ctx.providerId, groupDn);
  for (const object_guid of cachedMembers) {
    if (refreshed.has(object_guid)) continue;
    try {
      const user = await ctx.provider.getUser({ kind: 'objectGuid', value: object_guid });
      if (user) await upsertUser(ctx.db, ctx.providerId, user, { source: 'sync' });
      refreshed.add(object_guid);
    } catch (err) {
      ctx.log.warn({ err, guid: object_guid }, 'former group member refresh failed');
    }
  }
  return refreshed.size;
}
