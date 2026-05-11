// SPDX-License-Identifier: BUSL-1.1
import type { RunnerContext, RunnerResult } from '../types.js';
import { SignInEventsService } from '../../signInEvents.js';

// Delta sync of Microsoft Entra sign-in events into entra_signin_events.
// Cadence: 15 minutes by default. Each run pulls events newer than the
// last successful run minus a 5-minute overlap window — the overlap
// catches any events that arrived at Graph after our cursor moved past
// them, and ON CONFLICT DO NOTHING keeps the dedupe cheap.
//
// First run with no cursor pulls everything Entra retains for the
// tenant (30d on P1, 90d on P2). Subsequent runs are bounded by the
// overlap and tend to be small.

export async function runEntraSignInsEvents(ctx: RunnerContext): Promise<RunnerResult> {
  if (!ctx.entra) {
    throw new Error('entra runtime missing — scheduler should have skipped this task');
  }
  if (!ctx.entra.integration.features.signInEvents) {
    return { stats: { skipped: 'signInEvents feature disabled' } };
  }

  // The service is stateless aside from the db handle; instantiate
  // per-run so the runner doesn't need scheduler-level wiring.
  const svc = new SignInEventsService(ctx.db, ctx.log);

  // Use lastSuccessfulRunAt as the lower bound. Falls back to the
  // cursor (ISO timestamp string) if a previous run set one — they
  // should agree, but if a runner change ever decouples them, prefer
  // the cursor.
  const sinceFromCursor = ctx.lastCursor ? new Date(ctx.lastCursor) : null;
  const since = sinceFromCursor ?? ctx.lastSuccessfulRunAt;

  const result = await svc.syncRecent(ctx.providerId, ctx.entra.graph, since);

  return {
    cursor: new Date().toISOString(),
    stats: {
      pages: result.pages,
      scanned: result.scanned,
      inserted: result.inserted,
      ...(result.partial ? { partial: true } : {}),
      ...(result.denied ? { denied: true } : {}),
    },
  };
}
