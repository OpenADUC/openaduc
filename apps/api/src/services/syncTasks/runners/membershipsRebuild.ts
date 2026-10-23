// SPDX-License-Identifier: BUSL-1.1
import { rebuildMemberships } from '../../ouCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Rebuilds the membership join tables: user_group_memberships from cached
 * users' `memberOf`, group_group_memberships from cached groups' `member`.
 * All-local SQL — no LDAP traffic. Triggered after the user / group deltas
 * observe any change, plus a half-hour safety net cadence.
 */
export async function runMembershipsRebuild(ctx: RunnerContext): Promise<RunnerResult> {
  const { count } = await rebuildMemberships(ctx.db, ctx.providerId);
  return { stats: { membershipsRebuilt: count } };
}
