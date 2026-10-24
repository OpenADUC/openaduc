// SPDX-License-Identifier: BUSL-1.1
import { licensedEntraGroups } from '../../entraLicenses.js';
import { replaceLicensedGroups } from '../../licenseCache.js';
import type { RunnerContext, RunnerResult } from '../types.js';

// Reads every Entra group that grants a licence into entra_group_licenses,
// so group pickers badge licensed groups without asking Graph. One list
// query (licensed groups are few) plus the tenant's subscriptions.
//
// Permissions: Group.Read.All, and LicenseAssignment.Read.All for the part
// numbers of products Microsoft's name list lacks.

export async function runEntraLicensedGroups(ctx: RunnerContext): Promise<RunnerResult> {
  if (!ctx.entra) {
    throw new Error('entra runtime missing — scheduler should have skipped this task');
  }
  if (!ctx.entra.integration.features.licenses) {
    return { stats: { skipped: 'licenses feature disabled' } };
  }
  const groups = await licensedEntraGroups({ graph: ctx.entra.graph });
  await replaceLicensedGroups(ctx.db, ctx.providerId, groups);
  return {
    // The licensed-groups route reports this as when the cache was refreshed.
    cursor: new Date().toISOString(),
    stats: {
      groups: groups.length,
      synced: groups.filter((g) => g.onPremisesSid).length,
    },
  };
}
