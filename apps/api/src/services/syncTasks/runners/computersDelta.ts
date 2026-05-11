// SPDX-License-Identifier: BUSL-1.1
import { upsertComputer } from '../../computerCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

const OVERLAP_MS = 5 * 60_000;

/**
 * Incremental computer sync. Same shape as users.delta / groups.delta —
 * pulls `whenChanged>=lastSuccess - 5m` and upserts. Picks up new joins,
 * OS upgrades, dnsHostName changes, and renames. lastLogonTimestamp is
 * replicated lazily (every 9–14 days by default), so its drift is
 * smoothed by the daily computers.full crawl.
 */
export async function runComputersDelta(ctx: RunnerContext): Promise<RunnerResult> {
  const since = ctx.lastSuccessfulRunAt
    ? new Date(ctx.lastSuccessfulRunAt.getTime() - OVERLAP_MS)
    : undefined;

  let seen = 0;
  let upserted = 0;
  let lastError: unknown = null;
  for await (const computer of ctx.provider.syncComputers(since ? { modifiedSince: since } : {})) {
    seen++;
    try {
      await upsertComputer(ctx.db, ctx.providerId, computer);
      upserted++;
    } catch (err) {
      lastError = err;
      ctx.log.warn({ err, guid: computer.objectGuid }, 'computer upsert failed');
    }
  }

  // Fail loudly when AD returned entries but every upsert blew up. Without
  // this, a systemic write failure (missing table, schema mismatch, broken
  // pool) is hidden behind a green "succeeded" status, and the next delta
  // tick uses *this* run's clock as its modifiedSince cutoff — so the
  // missed rows never show up again until something modifies them in AD.
  if (seen > 0 && upserted === 0) {
    const message = lastError instanceof Error ? lastError.message : 'every computer upsert failed';
    throw new Error(`computers.delta: 0 of ${seen} entries written — ${message}`);
  }

  return {
    cursor: new Date().toISOString(),
    stats: {
      computersSeen: seen,
      computersUpserted: upserted,
      modifiedSince: since?.toISOString() ?? null,
    },
  };
}
