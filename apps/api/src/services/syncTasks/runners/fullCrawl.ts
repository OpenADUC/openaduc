// SPDX-License-Identifier: BUSL-1.1
import type { RunnerContext } from '../types.js';

type CachedTable = 'user_cache_records' | 'group_cache_records' | 'computer_cache_records';

export interface FullCrawlOutcome {
  kind: 'users' | 'groups' | 'computers';
  table: CachedTable;
  /** Entries the directory returned. */
  found: number;
  /** Entries written to the cache. */
  written: number;
  lastError: unknown;
}

/**
 * Decide whether a full crawl's result can be trusted to mark unseen rows
 * stale. Throws (failing the task, leaving the cache alone) when the crawl
 * looks broken rather than empty: nothing written, or nothing returned
 * while the cache isn't empty, which is what a service account that lost
 * its list rights sees. Returns false when some writes failed, so rows that
 * merely failed to save aren't marked stale.
 */
export async function shouldMarkStale(
  ctx: RunnerContext,
  crawl: FullCrawlOutcome,
): Promise<boolean> {
  if (crawl.found > 0 && crawl.written === 0) {
    const message =
      crawl.lastError instanceof Error
        ? crawl.lastError.message
        : `every ${crawl.kind} upsert failed`;
    throw new Error(`${crawl.kind}.full: 0 of ${crawl.found} entries written — ${message}`);
  }
  if (crawl.found === 0) {
    const cached = await ctx.db
      .selectFrom(crawl.table)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('provider_id', '=', ctx.providerId)
      .where('stale_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(cached.n) > 0) {
      throw new Error(
        `${crawl.kind}.full: the directory returned no ${crawl.kind}, but ${cached.n} are cached. ` +
          `Check that the service account can still list ${crawl.kind} under the base DN; the cache was left as it was.`,
      );
    }
  }
  if (crawl.written < crawl.found) {
    ctx.log.warn(
      { found: crawl.found, written: crawl.written },
      `${crawl.kind}.full: some upserts failed; not marking unseen rows stale this run`,
    );
    return false;
  }
  return true;
}
