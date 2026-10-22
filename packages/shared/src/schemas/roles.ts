// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

/** How many of a role group's direct members the Roles tab lists. */
export const ROLE_MEMBERS_SHOWN = 20;

export const roleMemberSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  samAccountName: z.string(),
});

export const roleMappingSchema = z.object({
  groupDn: z.string().nullable(),
  groupName: z.string().nullable(),
  /** Direct members in the cache; null when the group isn't cached. */
  memberCount: z.number().int().nullable(),
  /** The first ROLE_MEMBERS_SHOWN direct members, by display name. */
  members: z.array(roleMemberSchema),
});
export type RoleMapping = z.infer<typeof roleMappingSchema>;

export const rolesResponseSchema = z.object({
  roles: z.object({
    admin: roleMappingSchema,
    operator: roleMappingSchema,
    auditor: roleMappingSchema,
  }),
});
export type RolesResponse = z.infer<typeof rolesResponseSchema>;

const groupDnField = z.string().trim().min(1).max(1024).nullable().optional();

/** Any of the roles as a group DN, or null to unassign. */
export const rolesUpdateRequestSchema = z
  .object({
    admin: groupDnField,
    operator: groupDnField,
    auditor: groupDnField,
    // Moving the admin role to a group the current admin isn't in, or
    // clearing it, would lock them out at their next sign-in; they have to
    // say they mean it.
    confirmAdminChange: z.boolean().optional(),
  })
  .strict();
export type RolesUpdateRequest = z.infer<typeof rolesUpdateRequestSchema>;
