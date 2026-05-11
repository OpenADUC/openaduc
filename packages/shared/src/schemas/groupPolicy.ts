// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// Group Policy Container (GPC) summary as returned by the API. Mirrors
// `DirectoryGroupPolicy` on the provider side. The list response is a flat
// array (no pagination): GPOs per domain are usually < 100, so the
// frontend can hold the whole set.

export const groupPolicyLinkSchema = z.object({
  // DN of the OU / domain root that links the GPO.
  scopeDn: z.string(),
  // Position within the scope's gPLink string. Lower is higher precedence
  // for equal-enforcement links.
  order: z.number().int(),
  flagsRaw: z.number().int(),
  enabled: z.boolean(),
  enforced: z.boolean(),
});
export type GroupPolicyLink = z.infer<typeof groupPolicyLinkSchema>;

export const groupPolicySummarySchema = z.object({
  // objectGUID (canonical UUID). Used as the route param for detail.
  id: z.string(),
  // Curly-braced GPO GUID from the CN — the value gPLink references.
  gpoGuid: z.string(),
  distinguishedName: z.string(),
  displayName: z.string().nullable(),
  fileSysPath: z.string().nullable(),
  versionNumberRaw: z.number().int().nullable(),
  userVersion: z.number().int().nullable(),
  computerVersion: z.number().int().nullable(),
  flagsRaw: z.number().int().nullable(),
  userPolicyEnabled: z.boolean(),
  computerPolicyEnabled: z.boolean(),
  wmiFilterRef: z.string().nullable(),
  computerExtensionGuids: z.array(z.string()),
  userExtensionGuids: z.array(z.string()),
  createdAtSource: z.string().nullable(),
  modifiedAtSource: z.string().nullable(),
  // Aggregated link count from the gPLink scan. Surfaced on the list view so
  // operators can see at a glance which GPOs are unlinked.
  linkCount: z.number().int(),
});
export type GroupPolicySummary = z.infer<typeof groupPolicySummarySchema>;

export const groupPolicyListResponseSchema = z.object({
  policies: z.array(groupPolicySummarySchema),
  // When the live LDAP query was issued. Lets the UI label freshness.
  fetchedAt: z.string(),
});
export type GroupPolicyListResponse = z.infer<typeof groupPolicyListResponseSchema>;

export const groupPolicyDetailSchema = groupPolicySummarySchema.extend({
  functionalityVersion: z.number().int().nullable(),
  // Every populated LDAP attribute on the GPC entry. Same audit shape as the
  // user/group/computer Raw view.
  rawAttributes: z.record(z.string(), z.unknown()),
  // Every gPLink association referencing this GPO, in source order. The
  // scopeDn lets the operator follow the link back to the OU/domain.
  links: z.array(groupPolicyLinkSchema),
  fetchedAt: z.string(),
});
export type GroupPolicyDetail = z.infer<typeof groupPolicyDetailSchema>;
