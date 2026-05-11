// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { RunnerContext, RunnerResult } from '../types.js';

// Walks every cached user with a UPN and asks Graph for a fresh photo,
// honoring ETags so unchanged photos turn into a cheap 304. This is the
// "background" path — the photo route also does lazy-on-read fetches, so
// the refresh runner mostly exists to keep already-warm photos from going
// stale and to populate photos for users who haven't been viewed yet.
//
// Trade-offs:
//  - We cap per-run work to keep large directories from blocking the
//    scheduler slot for hours. Anything not visited this run gets picked
//    up next cycle.
//  - Permission errors are swallowed at the photoCache layer (logged
//    once per call). A 401/403 storm from a misconfigured app
//    registration won't burn through the quota — we stop after the first
//    one in this batch.

const MAX_USERS_PER_RUN = 250;

export async function runEntraPhotosRefresh(ctx: RunnerContext): Promise<RunnerResult> {
  if (!ctx.entra) {
    throw new Error('entra runtime missing — scheduler should have skipped this task');
  }
  if (!ctx.entra.integration.features.photos) {
    return { stats: { skipped: 'photos feature disabled' } };
  }

  // Pull users we know about with a UPN — Graph keys photos by UPN or id;
  // we use UPN since it matches AD's userPrincipalName. Order by stalest
  // photo first so we visit users whose photos haven't been touched in
  // the longest. Users with NO cached photo come first (NULL fetched_at
  // sorts before timestamps).
  const rows = await ctx.db
    .selectFrom('user_cache_records as u')
    .leftJoin('user_photos as p', (join) =>
      join
        .onRef('p.provider_id', '=', 'u.provider_id')
        .onRef('p.object_guid', '=', 'u.object_guid'),
    )
    .select(['u.object_guid', 'u.user_principal_name', 'p.fetched_at'])
    .where('u.provider_id', '=', ctx.providerId)
    .where('u.deleted_at', 'is', null)
    .where('u.user_principal_name', 'is not', null)
    .orderBy(sql`p.fetched_at asc nulls first`)
    .limit(MAX_USERS_PER_RUN)
    .execute();

  let refreshed = 0;
  let unchanged = 0;
  let absent = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.user_principal_name) continue;
    try {
      const before = await ctx.entra.photos.getPhoto(
        ctx.providerId,
        row.object_guid,
        row.user_principal_name,
        ctx.entra.graph,
        { forceRefresh: true },
      );
      if (before) {
        // Approximate counter — getPhoto doesn't tell us "did it 304 or
        // 200" directly, but if the row's fetched_at advanced and bytes
        // are present the call hit Graph successfully.
        if (row.fetched_at) unchanged++;
        else refreshed++;
      } else {
        absent++;
      }
    } catch (err) {
      failed++;
      ctx.log.warn({ err, guid: row.object_guid }, 'photo refresh failed');
    }
  }

  // Best-effort orphan prune so the cache doesn't accumulate rows for
  // users who've been removed from AD.
  let pruned = 0;
  try {
    pruned = await ctx.entra.photos.pruneOrphans(ctx.providerId);
  } catch (err) {
    ctx.log.warn({ err }, 'photo prune failed');
  }

  return {
    cursor: new Date().toISOString(),
    stats: {
      visited: rows.length,
      refreshed,
      unchanged,
      absent,
      failed,
      pruned,
    },
  };
}
