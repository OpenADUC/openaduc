// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import { computerWriteBlockSchema } from './computer.js';

export const directoryOuSchema = z.object({
  distinguishedName: z.string(),
  name: z.string(),
  // Null for OUs whose parent is the directory root (or any non-OU container).
  parentDn: z.string().nullable(),
  // The AD `description` attribute. Extracted from raw_attributes_json at
  // read time rather than promoted to its own column — it's only surfaced
  // for context (in the OU browser context menu, hover hints, etc.) and a
  // schema migration just for one optional string isn't worth it.
  description: z.string().nullable(),
  // True when the row hasn't been seen by the most recent sync — surfaced so
  // the UI can dim/strikethrough OUs that may no longer exist.
  stale: z.boolean(),
});
export type DirectoryOu = z.infer<typeof directoryOuSchema>;

export const ouListResponseSchema = z.object({
  ous: z.array(directoryOuSchema),
});
export type OuListResponse = z.infer<typeof ouListResponseSchema>;

/** An OU as a job or preview names it. */
export const ouRefSchema = z.object({ distinguishedName: z.string(), name: z.string() });
export type OuRef = z.infer<typeof ouRefSchema>;

export const moveRequestSchema = z.object({
  // The new parent OU's DN. The server validates that it exists in the
  // cached directory_ous table for the active provider before issuing the
  // modifyDN to AD.
  targetOuDn: z.string().min(1).max(1024),
});
export type MoveRequest = z.infer<typeof moveRequestSchema>;

// OU name constraints for create:
//   - 1..64 characters after trimming
//   - no DN-special chars (RFC 4514): , = + < > # ; \ " and the NUL byte
//   - no leading/trailing whitespace (the trim happens server-side, but we
//     reject inputs that would collapse to empty)
//   - no leading `#` (AD treats it as a hex-prefixed binary RDN value)
const ouNameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(64, 'name is too long')
  .regex(/^[^,=+<>#;\\"]+$/, 'name contains a reserved character')
  .refine((v) => !v.includes('\u0000'), 'name cannot contain a NUL byte')
  .refine((v) => !v.startsWith('#'), 'name cannot start with #');

export const ouCreateRequestSchema = z.object({
  parentDn: z.string().min(1).max(1024),
  name: ouNameSchema,
  description: z.string().max(1024).optional().nullable(),
});
export type OuCreateRequest = z.infer<typeof ouCreateRequestSchema>;

export const ouDeleteRequestSchema = z.object({
  dn: z.string().min(1).max(1024),
});
export type OuDeleteRequest = z.infer<typeof ouDeleteRequestSchema>;

// Description is the only mutable field today. Rename (modifyDN-of-OU) is
// intentionally omitted — the cascading DN rewrite across our cache and
// audit trail isn't worth the convenience.
//   undefined → field absent from patch (skip)
//   null      → clear the attribute on AD
//   string    → replace (or clear, if it trims to empty)
export const ouUpdateRequestSchema = z.object({
  dn: z.string().min(1).max(1024),
  patch: z
    .object({
      description: z.string().max(1024).nullable().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must contain at least one field' }),
});
export type OuUpdateRequest = z.infer<typeof ouUpdateRequestSchema>;

// Lightweight rows for the OU browser view (right pane). Kept narrower than
// userSummary/groupSummary because the browser shows many at once and only
// needs enough to render a clickable row that links to the detail page.
export const ouUserRowSchema = z.object({
  id: z.string(),
  samAccountName: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  enabled: z.boolean(),
  locked: z.boolean(),
});
export type OuUserRow = z.infer<typeof ouUserRowSchema>;

export const ouGroupRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  samAccountName: z.string().nullable(),
  description: z.string().nullable(),
});
export type OuGroupRow = z.infer<typeof ouGroupRowSchema>;

export const ouComputerRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  samAccountName: z.string().nullable(),
  dnsHostName: z.string().nullable(),
  operatingSystem: z.string().nullable(),
  enabled: z.boolean(),
  writeBlock: computerWriteBlockSchema.nullable(),
});
export type OuComputerRow = z.infer<typeof ouComputerRowSchema>;

// One linked GPO row in the OU contents response. `scopeDn` is the OU/domain
// DN that carries the gPLink — same as the selected OU for "linked" rows,
// an ancestor (parent OU or domain root) for "inherited" rows. `scopeName`
// is a friendly label (the leaf RDN of the scope) so the UI doesn't have to
// parse DNs.
export const ouGroupPolicyRowSchema = z.object({
  id: z.string(),
  gpoGuid: z.string(),
  displayName: z.string().nullable(),
  enabled: z.boolean(),
  enforced: z.boolean(),
  // Position within the scope's gPLink string. Lower = higher precedence at
  // that scope.
  order: z.number().int(),
  scopeDn: z.string(),
  scopeName: z.string().nullable(),
});
export type OuGroupPolicyRow = z.infer<typeof ouGroupPolicyRowSchema>;

export const ouContentsResponseSchema = z.object({
  users: z.array(ouUserRowSchema),
  groups: z.array(ouGroupRowSchema),
  computers: z.array(ouComputerRowSchema),
  // GPOs linked at this OU directly. Order matches AD precedence (lowest
  // `order` first applied).
  linkedGroupPolicies: z.array(ouGroupPolicyRowSchema),
  // GPOs linked at any ancestor (parent OU, …, domain root). Includes the
  // scope each link came from. Walks up the OU tree; closer ancestors come
  // first.
  inheritedGroupPolicies: z.array(ouGroupPolicyRowSchema),
});
export type OuContentsResponse = z.infer<typeof ouContentsResponseSchema>;
