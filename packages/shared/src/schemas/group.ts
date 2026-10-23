// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import { listFreshnessSchema } from './freshness.js';
import { samAccountNameSchemaOf } from './user.js';
import { ROLES } from '../capabilities.js';

export const groupSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  samAccountName: z.string().nullable(),
  distinguishedName: z.string(),
  description: z.string().nullable(),
  groupType: z.string().nullable(),
  groupScope: z.string().nullable(),
  memberCount: z.number().int(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const groupSearchQuerySchema = z.object({
  q: z.string().max(256).optional(),
  type: z.enum(['security', 'distribution']).optional(),
  scope: z.enum(['global', 'domain-local', 'universal']).optional(),
  hasMembers: z.enum(['yes', 'no']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Cap raised to 50_000 so the web client can load the full dataset
  // in one request and filter/sort entirely in the browser.
  pageSize: z.coerce.number().int().min(1).max(50_000).default(50),
  sort: z
    .enum(['name', 'samAccountName', 'memberCount', 'groupType', 'groupScope'])
    .default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type GroupSearchQuery = z.infer<typeof groupSearchQuerySchema>;

export const groupSearchResponseSchema = z.object({
  rows: z.array(groupSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  freshness: listFreshnessSchema,
});
export type GroupSearchResponse = z.infer<typeof groupSearchResponseSchema>;

const userGroupMemberSchema = z.object({
  kind: z.literal('user'),
  id: z.string(),
  samAccountName: z.string(),
  userPrincipalName: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  enabled: z.boolean(),
  locked: z.boolean(),
  passwordNeverExpires: z.boolean(),
});

/** A group nested in another. */
const nestedGroupMemberSchema = z.object({
  kind: z.literal('group'),
  id: z.string(),
  name: z.string().nullable(),
  samAccountName: z.string().nullable(),
  distinguishedName: z.string(),
  description: z.string().nullable(),
  groupType: z.string().nullable(),
  groupScope: z.string().nullable(),
});

export const groupMemberSchema = z.discriminatedUnion('kind', [
  userGroupMemberSchema,
  nestedGroupMemberSchema,
]);
export type GroupMember = z.infer<typeof groupMemberSchema>;

export const groupDetailSchema = groupSummarySchema.extend({
  email: z.string().nullable(),
  members: z.array(groupMemberSchema),
  freshness: z.object({
    cachedAt: z.string().nullable(),
    liveRefreshedAt: z.string().nullable(),
  }),
});
export type GroupDetail = z.infer<typeof groupDetailSchema>;

// ---- Create ------------------------------------------------------------

export const GROUP_SCOPES = ['domain-local', 'global', 'universal'] as const;
export type GroupScope = (typeof GROUP_SCOPES)[number];
export const GROUP_TYPES = ['security', 'distribution'] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

// The group's cn, which AD also shows as its name. AD caps cn at 64
// characters; DN-special characters are refused rather than escaped so the
// name reads the same everywhere it appears.
export const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(64, 'name is too long')
  .regex(/^[^,=+<>;\\"]+$/, 'name can’t contain , = + < > ; \\ "')
  .refine((v) => !v.startsWith('#'), 'name can’t start with #');

// AD caps sAMAccountName at 256 characters; only users are held to 20.
export const groupSamAccountNameSchema = samAccountNameSchemaOf(256);

export const groupCreateRequestSchema = z
  .object({
    // An OU from the cache; the group is created directly under it.
    parentDn: z.string().min(1).max(1024),
    name: groupNameSchema,
    samAccountName: groupSamAccountNameSchema,
    description: z.string().trim().max(1024).nullable().optional(),
    scope: z.enum(GROUP_SCOPES),
    type: z.enum(GROUP_TYPES),
  })
  .strict();
export type GroupCreateRequest = z.input<typeof groupCreateRequestSchema>;

// Whether a new group's names are free: its name among the OU's direct
// children, its pre-Windows 2000 name across the whole domain (users and
// computers included). Either may be omitted to check only the other.
export const groupNameCheckQuerySchema = z.object({
  parentDn: z.string().min(1).max(1024),
  name: z.string().trim().max(256).optional(),
  samAccountName: z.string().trim().max(256).optional(),
});
export type GroupNameCheckQuery = z.infer<typeof groupNameCheckQuerySchema>;

export const groupNameCheckResponseSchema = z.object({
  // The DN of the object already holding each name, or null when free.
  nameTakenBy: z.string().nullable(),
  samAccountNameTakenBy: z.string().nullable(),
});
export type GroupNameCheckResponse = z.infer<typeof groupNameCheckResponseSchema>;

// ---- Delete ------------------------------------------------------------
//
// Groups AD or Windows rely on can't be deleted. The server checks the live
// entry immediately before the delete.

export const groupDeleteBlockReasonSchema = z.enum([
  // isCriticalSystemObject=TRUE (Domain Admins, Domain Users, …).
  'critical_system_object',
  // A built-in group: in CN=Builtin, flagged builtin in groupType, or a
  // well-known RID below 1000.
  'builtin_group',
  // adminCount=1: AdminSDHolder protects it as an administrative group.
  'protected_group',
  // Mapped to an OpenADUC role: deleting it would take that role away.
  'role_group',
  // Directly a member of a protected group (Domain Admins, Administrators,
  // … or any adminCount=1 group), which AdminSDHolder may not have
  // flagged yet.
  'member_of_protected_group',
  // Some account's primary group (its primaryGroupID): AD refuses.
  'primary_group',
]);
export type GroupDeleteBlockReason = z.infer<typeof groupDeleteBlockReasonSchema>;

export const groupDeleteRequestSchema = z
  .object({
    // Must match the group's current pre-Windows 2000 name
    // (case-insensitive), so a wrong id fails instead of deleting another
    // group.
    confirmSamAccountName: z.string().min(1).max(256),
  })
  .strict();
export type GroupDeleteRequest = z.infer<typeof groupDeleteRequestSchema>;

export const groupDeletePreflightResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  samAccountName: z.string().nullable(),
  distinguishedName: z.string(),
  // Direct members (users, groups, computers, contacts) the group holds.
  memberCount: z.number().int(),
  // The groups this one is directly a member of. `id` is null for a group
  // OpenADUC hasn't cached (outside the base DN, or not synced yet).
  memberOf: z.array(
    z.object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      distinguishedName: z.string(),
      // A protected group (see member_of_protected_group).
      protected: z.boolean(),
    }),
  ),
  // Accounts (users, computers) whose primary group this is. They aren't
  // in `member`, so memberCount leaves them out. Null when AD couldn't be
  // asked.
  primaryGroupMembers: z.number().int().nullable(),
  blockedReason: groupDeleteBlockReasonSchema.nullable(),
  // The OpenADUC role the group grants, when that's why it's blocked.
  role: z.enum(ROLES).nullable(),
});
export type GroupDeletePreflightResponse = z.infer<typeof groupDeletePreflightResponseSchema>;
