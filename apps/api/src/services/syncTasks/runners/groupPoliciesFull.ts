// SPDX-License-Identifier: BUSL-1.1
import {
  markGroupPoliciesStale,
  replaceGroupPolicyLinks,
  upsertGroupPolicy,
} from '../../groupPolicyCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Full Group Policy crawl. GPOs change rarely (operator edits in GPMC,
 * occasional new policy roll-outs) so a daily refresh is plenty. The runner
 * issues two LDAP queries:
 *
 *   1. groupPolicyContainer entries — the GPO catalog itself.
 *   2. Every object in the domain naming context with a populated `gPLink`
 *      attribute — the OU/domain ⇄ GPO links.
 *
 * Both are cached. The OU browser and the policies list page read the cache
 * instead of issuing live LDAP, so a slow DC doesn't make the policies tab
 * feel like every click is a network round-trip.
 */
export async function runGroupPoliciesFull(ctx: RunnerContext): Promise<RunnerResult> {
  const [policies, links] = await Promise.all([
    ctx.provider.searchGroupPolicies(),
    ctx.provider.getGroupPolicyLinks(),
  ]);

  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const gpo of policies) {
    try {
      await upsertGroupPolicy(ctx.db, ctx.providerId, gpo);
      seen.add(gpo.objectGuid);
    } catch (err) {
      lastError = err;
      ctx.log.warn({ err, guid: gpo.objectGuid }, 'group policy upsert failed');
    }
  }
  if (policies.length > 0 && seen.size === 0) {
    const message =
      lastError instanceof Error ? lastError.message : 'every group policy upsert failed';
    throw new Error(`policies.full: 0 of ${policies.length} GPOs written — ${message}`);
  }

  await markGroupPoliciesStale(ctx.db, ctx.providerId, seen);
  await replaceGroupPolicyLinks(ctx.db, ctx.providerId, links);

  return {
    cursor: new Date().toISOString(),
    stats: {
      policiesSeen: policies.length,
      policiesUpserted: seen.size,
      linksWritten: links.length,
    },
  };
}
