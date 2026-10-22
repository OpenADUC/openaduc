// SPDX-License-Identifier: BUSL-1.1
import { markComputersStale, upsertComputer } from '../../computerCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';
import { shouldMarkStale } from './fullCrawl.js';

/**
 * Full computer crawl + stale-mark for unseen rows. Daily reconciliation
 * absorbs replication-lag drift on lastLogonTimestamp and catches anything
 * the delta missed (e.g. operator-edited attributes that don't bump
 * whenChanged perceptibly within the delta window).
 */
export async function runComputersFull(ctx: RunnerContext): Promise<RunnerResult> {
  const seen = new Set<string>();
  let total = 0;
  let lastError: unknown = null;

  for await (const computer of ctx.provider.syncComputers({})) {
    total++;
    try {
      await upsertComputer(ctx.db, ctx.providerId, computer);
      seen.add(computer.objectGuid);
    } catch (err) {
      lastError = err;
      ctx.log.warn({ err, guid: computer.objectGuid }, 'computer upsert failed');
    }
  }

  const crawl = { found: total, written: seen.size, lastError };
  if (
    await shouldMarkStale(ctx, { kind: 'computers', table: 'computer_cache_records', ...crawl })
  ) {
    await markComputersStale(ctx.db, ctx.providerId, seen);
  }

  return {
    cursor: new Date().toISOString(),
    stats: { computersSeen: total, computersUpserted: seen.size },
  };
}
