// SPDX-License-Identifier: BUSL-1.1
import { upsertUser } from '../../userCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

// Overlap window — re-pull entries modified in the 5 minutes before the
// last successful run. Absorbs DC-to-DC replication lag and clock skew
// without making the delta significantly more expensive.
const OVERLAP_MS = 5 * 60_000;

/**
 * Incremental user sync. Filters with `whenChanged>=lastSuccessAt - 5m`
 * and upserts whatever AD returns. Cheap on every directory because the
 * working set is "what changed in the last interval".
 *
 * Does NOT rebuild memberships itself — emits a `memberships.rebuild`
 * trigger so a single rebuild covers user + group deltas.
 *
 * On first run (no cursor), behaves like a full crawl. The next
 * scheduled `users.full` will reconcile anything missed.
 */
export async function runUsersDelta(ctx: RunnerContext): Promise<RunnerResult> {
  const since = ctx.lastSuccessfulRunAt
    ? new Date(ctx.lastSuccessfulRunAt.getTime() - OVERLAP_MS)
    : undefined;

  let count = 0;
  for await (const user of ctx.provider.syncUsers(since ? { modifiedSince: since } : {})) {
    try {
      await upsertUser(ctx.db, ctx.providerId, user, { source: 'sync' });
      count++;
    } catch (err) {
      ctx.log.warn({ err, guid: user.objectGuid }, 'user upsert failed');
    }
  }

  return {
    cursor: new Date().toISOString(),
    stats: {
      usersSeen: count,
      modifiedSince: since?.toISOString() ?? null,
    },
    triggers: count > 0 ? ['memberships.rebuild'] : [],
  };
}
