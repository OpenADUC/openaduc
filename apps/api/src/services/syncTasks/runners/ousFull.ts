// SPDX-License-Identifier: BUSL-1.1
import { markOusStale, upsertOu } from '../../ouCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Full OU crawl. OUs barely change — runs weekly by default.
 */
export async function runOusFull(ctx: RunnerContext): Promise<RunnerResult> {
  const seen = new Set<string>();
  let count = 0;

  for await (const ou of ctx.provider.syncOus({})) {
    try {
      await upsertOu(ctx.db, ctx.providerId, ou);
      seen.add(ou.distinguishedName.toLowerCase());
      count++;
    } catch (err) {
      ctx.log.warn({ err, dn: ou.distinguishedName }, 'OU upsert failed');
    }
  }

  await markOusStale(ctx.db, ctx.providerId, seen);

  return {
    cursor: new Date().toISOString(),
    stats: { ousSeen: count },
  };
}
