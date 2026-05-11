// SPDX-License-Identifier: BUSL-1.1
import { GraphPermissionError } from '../../graphClient.js';
import type { RunnerContext, RunnerResult } from '../types.js';

// Pulls signInActivity for every cached user and stores it on
// user_entra_enrichment for the user-detail card to render. Two notes:
//
// 1) signInActivity is a P1-licensed feature. A tenant without P1 returns
//    HTTP 403 on the field; we detect that, mark the integration's last
//    test status accordingly, and skip subsequent runs until the operator
//    re-enables the feature.
//
// 2) The endpoint paginates with @odata.nextLink. We follow it but cap
//    the number of pages per run so an enormous directory doesn't block
//    the scheduler slot. Whatever isn't visited persists from the
//    previous run; the data is "last 7-30 days of sign-ins" so a delay
//    between full passes doesn't lose information.
//
// Graph endpoint:
//   GET /users?$select=id,userPrincipalName,signInActivity&$top=200

const MAX_PAGES_PER_RUN = 25; // 25 * 200 = 5000 users per run

export async function runEntraSignInActivity(ctx: RunnerContext): Promise<RunnerResult> {
  if (!ctx.entra) {
    throw new Error('entra runtime missing — scheduler should have skipped this task');
  }
  if (!ctx.entra.integration.features.signInActivity) {
    return { stats: { skipped: 'signInActivity feature disabled' } };
  }

  let nextLink: string | null = '/users?$select=id,userPrincipalName,signInActivity&$top=200';
  let pages = 0;
  let updated = 0;
  let scanned = 0;
  let p1Required = false;

  type GraphUserPage = {
    value: Array<{
      id: string;
      userPrincipalName: string | null;
      signInActivity?: {
        lastSignInDateTime?: string | null;
        lastNonInteractiveSignInDateTime?: string | null;
      } | null;
    }>;
    '@odata.nextLink'?: string;
  };

  while (nextLink && pages < MAX_PAGES_PER_RUN) {
    let page: GraphUserPage;
    try {
      const res = await ctx.entra.graph.getJson<GraphUserPage>(nextLink);
      page = res.data;
    } catch (err) {
      if (err instanceof GraphPermissionError && err.statusCode === 403) {
        p1Required = true;
        ctx.log.warn(
          { hint: err.hint },
          'sign-in activity 403 — likely missing AuditLog.Read.All or Entra ID P1 license',
        );
        break;
      }
      throw err;
    }
    pages++;
    for (const u of page.value ?? []) {
      scanned++;
      // Match Graph's user.id back to AD's objectGuid via the cached UPN.
      // The UPN is the most reliable cross-walk in hybrid identity setups
      // — it's the same string in AD and Entra for synced users.
      if (!u.userPrincipalName) continue;
      const ad = await ctx.db
        .selectFrom('user_cache_records')
        .select(['object_guid'])
        .where('provider_id', '=', ctx.providerId)
        .where((eb) =>
          eb(eb.fn('lower', ['user_principal_name']), '=', u.userPrincipalName!.toLowerCase()),
        )
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!ad) continue; // user exists in Entra but not AD (cloud-only) — skip in v1.
      const last = u.signInActivity?.lastSignInDateTime
        ? new Date(u.signInActivity.lastSignInDateTime)
        : null;
      const lastNon = u.signInActivity?.lastNonInteractiveSignInDateTime
        ? new Date(u.signInActivity.lastNonInteractiveSignInDateTime)
        : null;
      await ctx.db
        .insertInto('user_entra_enrichment')
        .values({
          provider_id: ctx.providerId,
          object_guid: ad.object_guid,
          last_sign_in_at: last,
          last_non_interactive_sign_in_at: lastNon,
          entra_object_id: u.id,
          user_principal_name: u.userPrincipalName,
          last_status: 'success',
        })
        .onConflict((oc) =>
          oc.columns(['provider_id', 'object_guid']).doUpdateSet({
            last_sign_in_at: last,
            last_non_interactive_sign_in_at: lastNon,
            entra_object_id: u.id,
            user_principal_name: u.userPrincipalName,
            last_status: 'success',
            fetched_at: new Date(),
          }),
        )
        .execute();
      updated++;
    }
    nextLink = page['@odata.nextLink'] ?? null;
  }

  return {
    cursor: new Date().toISOString(),
    stats: {
      scanned,
      updated,
      pages,
      ...(p1Required ? { p1Required } : {}),
      ...(nextLink ? { partial: true } : {}),
    },
  };
}
