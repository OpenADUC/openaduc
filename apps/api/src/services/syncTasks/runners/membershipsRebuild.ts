// SPDX-License-Identifier: BUSL-1.1
import { rebuildMemberships } from '../../ouCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Rebuilds the user_group_memberships join table from cached `memberOf`
 * arrays. All-local SQL — no LDAP traffic. Triggered after the user /
 * group deltas observe any change, plus a half-hour safety net cadence.
 */
export async function runMembershipsRebuild(ctx: RunnerContext): Promise<RunnerResult> {
  const { count } = await rebuildMemberships(ctx.db, ctx.providerId);
  return { stats: { membershipsRebuilt: count } };
}
