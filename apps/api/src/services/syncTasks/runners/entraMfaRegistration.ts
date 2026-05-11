// SPDX-License-Identifier: BUSL-1.1
import { GraphPermissionError } from '../../graphClient.js';
import type { RunnerContext, RunnerResult } from '../types.js';

// Pulls MFA registration state for every Entra user via the
// /reports/authenticationMethods/userRegistrationDetails endpoint.
// Stores per-user fields on user_entra_enrichment (alongside sign-in
// activity).
//
// Permissions: AuditLog.Read.All (Application). The user already has
// this granted for the sign-in-activity feature, so MFA piggybacks
// without additional consent steps.
//
// Cadence is weekly by default. MFA registration changes rarely and the
// report endpoint is rate-limited per tenant; pulling daily is overkill.
//
// Cross-walk: each report row has `id` (Entra object id) and
// `userPrincipalName`. We match on UPN to user_cache_records (same
// strategy as the sign-in-activity runner) so cloud-only Entra users
// without an AD twin are skipped silently.

const MAX_PAGES_PER_RUN = 50; // 50 * 200 default = up to 10k users per run

interface GraphRegistrationRow {
  id?: string;
  userPrincipalName?: string | null;
  isMfaRegistered?: boolean | null;
  isMfaCapable?: boolean | null;
  isPasswordlessCapable?: boolean | null;
  methodsRegistered?: string[] | null;
  defaultMfaMethod?: string | null;
}

interface GraphRegistrationPage {
  value: GraphRegistrationRow[];
  '@odata.nextLink'?: string;
}

export async function runEntraMfaRegistration(ctx: RunnerContext): Promise<RunnerResult> {
  if (!ctx.entra) {
    throw new Error('entra runtime missing — scheduler should have skipped this task');
  }
  if (!ctx.entra.integration.features.mfaRegistration) {
    return { stats: { skipped: 'mfaRegistration feature disabled' } };
  }

  let nextLink: string | null = '/reports/authenticationMethods/userRegistrationDetails?$top=200';
  let pages = 0;
  let updated = 0;
  let scanned = 0;
  let skipped = 0;
  let denied = false;

  while (nextLink && pages < MAX_PAGES_PER_RUN) {
    let page: GraphRegistrationPage;
    try {
      const res = await ctx.entra.graph.getJson<GraphRegistrationPage>(nextLink);
      page = res.data;
    } catch (err) {
      if (
        err instanceof GraphPermissionError &&
        (err.statusCode === 403 || err.statusCode === 401)
      ) {
        denied = true;
        ctx.log.warn(
          { hint: err.hint, status: err.statusCode },
          'mfa report fetch denied — likely missing AuditLog.Read.All',
        );
        break;
      }
      throw err;
    }
    pages++;
    for (const row of page.value ?? []) {
      scanned++;
      if (!row.userPrincipalName) {
        skipped++;
        continue;
      }
      const ad = await ctx.db
        .selectFrom('user_cache_records')
        .select(['object_guid'])
        .where('provider_id', '=', ctx.providerId)
        .where((eb) =>
          eb(eb.fn('lower', ['user_principal_name']), '=', row.userPrincipalName!.toLowerCase()),
        )
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!ad) {
        // Cloud-only Entra user without an AD twin — skip in v1; surfacing
        // them would require a separate cache table.
        skipped++;
        continue;
      }
      const methods = Array.isArray(row.methodsRegistered) ? row.methodsRegistered : [];
      const fetchedAt = new Date();
      // Upsert: insert a fresh enrichment row OR update the existing
      // one in place. The non-MFA columns (entra_object_id, sign-in
      // activity) are left alone so this runner doesn't fight with the
      // sign-in-activity runner over the same row.
      await ctx.db
        .insertInto('user_entra_enrichment')
        .values({
          provider_id: ctx.providerId,
          object_guid: ad.object_guid,
          entra_object_id: row.id ?? null,
          user_principal_name: row.userPrincipalName,
          is_mfa_registered: row.isMfaRegistered ?? null,
          is_mfa_capable: row.isMfaCapable ?? null,
          is_passwordless_capable: row.isPasswordlessCapable ?? null,
          mfa_methods_json: JSON.stringify(methods),
          default_mfa_method: row.defaultMfaMethod ?? null,
          mfa_fetched_at: fetchedAt,
          mfa_last_status: 'success',
        })
        .onConflict((oc) =>
          oc.columns(['provider_id', 'object_guid']).doUpdateSet({
            entra_object_id: row.id ?? null,
            user_principal_name: row.userPrincipalName,
            is_mfa_registered: row.isMfaRegistered ?? null,
            is_mfa_capable: row.isMfaCapable ?? null,
            is_passwordless_capable: row.isPasswordlessCapable ?? null,
            mfa_methods_json: JSON.stringify(methods),
            default_mfa_method: row.defaultMfaMethod ?? null,
            mfa_fetched_at: fetchedAt,
            mfa_last_status: 'success',
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
      pages,
      scanned,
      updated,
      skipped,
      ...(denied ? { denied } : {}),
      ...(nextLink ? { partial: true } : {}),
    },
  };
}
