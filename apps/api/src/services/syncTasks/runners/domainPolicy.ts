// SPDX-License-Identifier: BUSL-1.1
import type { RunnerContext, RunnerResult } from '../types.js';

/**
 * Ping the domain root for password / lockout policy. The provider
 * caches internally for 5 min, so this task's job is mostly to keep the
 * cache warm and surface "policy unreadable" errors in the task table
 * before they hit operator screens.
 */
export async function runDomainPolicy(ctx: RunnerContext): Promise<RunnerResult> {
  const policy = await ctx.provider.getDomainPolicy();
  return {
    stats: {
      lockoutThreshold: policy.lockoutThreshold,
      lockoutDurationMs: policy.lockoutDurationMs,
      maxPwdAgeMs: policy.maxPwdAgeMs,
      minPwdLength: policy.minPwdLength,
    },
  };
}
