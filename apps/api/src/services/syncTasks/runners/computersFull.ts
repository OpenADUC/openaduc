// SPDX-License-Identifier: BUSL-1.1
import { markComputersStale, upsertComputer } from '../../computerCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

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

  // Same fail-loud guard as computers.delta — a systemic write failure
  // shouldn't masquerade as a successful empty crawl.
  if (total > 0 && seen.size === 0) {
    const message = lastError instanceof Error ? lastError.message : 'every computer upsert failed';
    throw new Error(`computers.full: 0 of ${total} entries written — ${message}`);
  }

  await markComputersStale(ctx.db, ctx.providerId, seen);

  return {
    cursor: new Date().toISOString(),
    stats: { computersSeen: total, computersUpserted: seen.size },
  };
}
