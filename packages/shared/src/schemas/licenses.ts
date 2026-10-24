// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// Microsoft licenses as Entra holds them, read-only: which products a user
// has and where each comes from, what a group grants, and which groups
// grant any. OpenADUC never assigns one. A product is named as Microsoft's
// admin centers name it, falling back to its part number.

/** Graph's licenseAssignmentState.error values, as Graph spells them. */
export const LICENSE_ASSIGNMENT_ERRORS = [
  'CountViolation',
  'MutuallyExclusiveViolation',
  'DependencyViolation',
  'ProhibitedInUsageLocationViolation',
  'UniquenessViolation',
  'Other',
] as const;
export type LicenseAssignmentError = (typeof LICENSE_ASSIGNMENT_ERRORS)[number];

/** What each assignment error means and what fixes it, in the admin centers' terms. */
export const LICENSE_ERROR_TEXT: Record<LicenseAssignmentError, string> = {
  CountViolation:
    'Not enough licenses: every one the tenant has of this product is assigned. Buy more, or free some up.',
  MutuallyExclusiveViolation:
    'Conflicting service plans: one of its service plans conflicts with a plan the user already has through another product.',
  DependencyViolation:
    'Other products depend on this license: another product the user has needs one of its service plans.',
  ProhibitedInUsageLocationViolation:
    'Usage location isn’t allowed: some of its services aren’t available in the user’s usage location.',
  UniquenessViolation:
    'Duplicate proxy addresses: another object in the tenant has one of the user’s proxy addresses.',
  Other: 'Microsoft Entra couldn’t assign it. The Microsoft 365 admin center says why.',
};

/** Why a license wasn't (fully) assigned, in the admin centers' terms; null when it was. */
export function licenseProblem(a: {
  state: string;
  error: LicenseAssignmentError | null;
}): string | null {
  return a.error || a.state === 'error' ? LICENSE_ERROR_TEXT[a.error ?? 'Other'] : null;
}

export const licenseSkuSchema = z.object({
  skuId: z.string(),
  /** e.g. `SPE_E3`; null when the tenant's subscriptions couldn't be read. */
  skuPartNumber: z.string().nullable(),
  /** e.g. "Microsoft 365 E3"; the part number, or failing that the id, when Microsoft's list lacks it. */
  name: z.string(),
});
export type LicenseSku = z.infer<typeof licenseSkuSchema>;

/** A group a license comes from. */
export const licenseGroupSchema = z.object({
  entraGroupId: z.string(),
  /** Its name in Entra; null when Entra wouldn't say. */
  name: z.string().nullable(),
  /** The AD group it's synced from (objectGUID); null for a cloud-only group or one not cached. */
  groupId: z.string().nullable(),
});
export type LicenseGroup = z.infer<typeof licenseGroupSchema>;

/** One way a user holds a product: directly, or through one group. */
export const licenseAssignmentSchema = z.object({
  /** Null when assigned directly. */
  group: licenseGroupSchema.nullable(),
  state: z.enum(['active', 'activeWithError', 'disabled', 'error']),
  error: z.enum(LICENSE_ASSIGNMENT_ERRORS).nullable(),
  /** Service plans of the product this assignment turns off. */
  disabledPlanCount: z.number().int(),
  lastUpdatedAt: z.string().nullable(),
});
export type LicenseAssignment = z.infer<typeof licenseAssignmentSchema>;

export const userLicenseSchema = licenseSkuSchema.extend({
  assignments: z.array(licenseAssignmentSchema).min(1),
});
export type UserLicense = z.infer<typeof userLicenseSchema>;

const unsyncedSchema = z.object({
  status: z.literal('unsynced'),
  /** When the tenant last synced from AD; null when it never has or couldn't be read. */
  lastSyncAt: z.string().nullable(),
});

export const userLicensesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('synced'), licenses: z.array(userLicenseSchema) }),
  unsyncedSchema,
]);
export type UserLicenses = z.infer<typeof userLicensesSchema>;

export const groupLicensesSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('synced'),
    licenses: z.array(licenseSkuSchema.extend({ disabledPlanCount: z.number().int() })),
    /** Graph's licenseProcessingState, e.g. `ProcessingComplete`; null when it has none. */
    processingState: z.string().nullable(),
  }),
  unsyncedSchema,
]);
export type GroupLicenses = z.infer<typeof groupLicensesSchema>;

/** Every AD group that grants a license, from the cache a sync task keeps. */
export const licensedGroupsSchema = z.object({
  /** The directory's Entra integration shows licenses. */
  enabled: z.boolean(),
  /** When the task last read every licensed group from Entra; null before it first has. */
  refreshedAt: z.string().nullable(),
  /** The task's latest run failed, so the badges may be out of date. */
  refreshFailed: z.boolean(),
  groups: z.array(z.object({ id: z.string(), licenses: z.array(licenseSkuSchema) })),
});
export type LicensedGroups = z.infer<typeof licensedGroupsSchema>;
