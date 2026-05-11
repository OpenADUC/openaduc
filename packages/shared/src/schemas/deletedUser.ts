// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// Recycle Bin / tombstone state surfaced from AD. Drives the UI banner that
// warns operators about reduced-attribute restores when the Recycle Bin
// optional feature isn't enabled on the domain.
export const recycleBinStatusSchema = z.object({
  // True when the AD Recycle Bin Optional Feature is enabled on the
  // configuration partition. False means the directory still uses
  // tombstones — restores succeed, but most attributes (incl. group
  // memberships) are stripped at delete time and can't be recovered.
  recycleBinEnabled: z.boolean(),
  // The CN=Deleted Objects container DN that holds deleted entries.
  // Returned for diagnostics; the API does not expose direct access.
  deletedObjectsContainer: z.string().nullable(),
  // Optional human-readable reason when we couldn't determine the
  // state (e.g. service account lacks read on Optional Features). The
  // UI falls back to "tombstone-only" wording when unknown.
  message: z.string().nullable(),
});
export type RecycleBinStatus = z.infer<typeof recycleBinStatusSchema>;

// Slimmer than userSummarySchema — AD only preserves a subset of attributes
// on deleted objects. Recycle-Bin-enabled domains keep most of these
// populated; tombstones may have only id / cn / sAM / lastKnownParent.
export const deletedUserSummarySchema = z.object({
  id: z.string(),
  // Original CN with the AD `\nADEL:<guid>` tombstone suffix stripped, so
  // the UI shows "Alice Adams" instead of "Alice Adams\nADEL:<guid>".
  cn: z.string().nullable(),
  samAccountName: z.string().nullable(),
  userPrincipalName: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  // The DN the entry currently lives at (under Deleted Objects), useful
  // when an operator wants to confirm the exact target before restore.
  deletedDn: z.string(),
  // Where the entry was deleted from. The restore writes back here unless
  // the operator overrides via targetParentDn. Null when AD didn't preserve
  // it (very old tombstones).
  lastKnownParent: z.string().nullable(),
  // When the object transitioned to deleted (AD's `whenChanged` on the
  // delete itself). Used as the "Deleted at" column.
  deletedAt: z.string().nullable(),
  // True when the entry has crossed the deleted-object-lifetime boundary
  // (Recycle Bin only) and AD has stripped it down to tombstone form.
  // Recycled entries cannot be restored.
  recycled: z.boolean(),
});
export type DeletedUserSummary = z.infer<typeof deletedUserSummarySchema>;

export const deletedUserSearchQuerySchema = z.object({
  q: z.string().max(256).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DeletedUserSearchQuery = z.infer<typeof deletedUserSearchQuerySchema>;

export const deletedUserSearchResponseSchema = z.object({
  rows: z.array(deletedUserSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  recycleBin: recycleBinStatusSchema,
});
export type DeletedUserSearchResponse = z.infer<typeof deletedUserSearchResponseSchema>;

// Detail view: same fields as the summary, plus whatever raw attributes AD
// preserved. For Recycle-Bin-enabled domains this can include department,
// title, etc.; for tombstones it'll be very sparse.
export const deletedUserDetailSchema = deletedUserSummarySchema.extend({
  rawAttributes: z.record(z.unknown()),
});
export type DeletedUserDetail = z.infer<typeof deletedUserDetailSchema>;

export const restoreUserRequestSchema = z.object({
  // When omitted, the restore reuses lastKnownParent. Pass an explicit DN
  // to restore into a different OU (useful when the original parent was
  // also deleted and not yet restored).
  targetParentDn: z.string().min(1).max(2048).optional(),
});
export type RestoreUserRequest = z.infer<typeof restoreUserRequestSchema>;

export const restoreUserResponseSchema = z.object({
  ok: z.literal(true),
  restoredDn: z.string(),
});
export type RestoreUserResponse = z.infer<typeof restoreUserResponseSchema>;
