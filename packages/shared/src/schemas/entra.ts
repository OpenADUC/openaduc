// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// The per-directory Microsoft Entra (Graph) integration: which features it
// can turn on, the application permissions those need, and what its
// connection test answers.

export const ENTRA_FEATURE_KEYS = [
  'photos',
  'signInActivity',
  'signInEvents',
  'mfaRegistration',
  'teamsAdminWebhook',
  'passwordExpiryNotifications',
  'temporaryAccessPass',
  'licenses',
] as const;
export type EntraFeatureKey = (typeof ENTRA_FEATURE_KEYS)[number];

/** An application permission, and the broader ones that grant it too. */
export interface GraphPermission {
  name: string;
  alsoMetBy: readonly string[];
}

/** What issuing a Temporary Access Pass needs, each the narrowest that will do. */
export const TAP_PERMISSIONS = {
  /** Narrower than UserAuthenticationMethod.ReadWrite.All, which manages every sign-in method. */
  issue: {
    name: 'UserAuthMethod-TAP.ReadWrite.All',
    alsoMetBy: ['UserAuthenticationMethod.ReadWrite.All'],
  },
  policy: {
    name: 'Policy.Read.AuthenticationMethod',
    alsoMetBy: ['Policy.ReadWrite.AuthenticationMethod'],
  },
  users: {
    name: 'User.Read.All',
    alsoMetBy: ['User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All'],
  },
  /** Active role assignments and PIM eligibilities alike. */
  roles: {
    name: 'RoleManagement.Read.Directory',
    alsoMetBy: ['RoleManagement.Read.All', 'RoleManagement.ReadWrite.Directory'],
  },
} as const satisfies Record<string, GraphPermission>;

/** What showing licenses needs: all reads, as OpenADUC never assigns one. */
export const LICENSE_PERMISSIONS = {
  /** A user's licenses and where each comes from (licenseAssignmentStates). */
  users: TAP_PERMISSIONS.users,
  /** The licenses a group grants, and the groups a user's licenses come from. */
  groups: {
    name: 'Group.Read.All',
    alsoMetBy: ['Group.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All'],
  },
  /**
   * The tenant's subscriptions (part numbers for products Microsoft's name
   * list lacks) and its last sync from AD, for a user or group not synced yet.
   */
  organization: {
    name: 'Organization.Read.All',
    alsoMetBy: ['Organization.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All'],
  },
} as const satisfies Record<string, GraphPermission>;

/** The permissions a feature needs that the connection test checks. */
export const ENTRA_FEATURE_PERMISSIONS: Partial<
  Record<EntraFeatureKey, readonly GraphPermission[]>
> = {
  temporaryAccessPass: Object.values(TAP_PERMISSIONS),
  licenses: Object.values(LICENSE_PERMISSIONS),
};

export const entraTestResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  tenantDisplayName: z.string().nullable(),
  /** Permissions a turned-on feature needs that the app registration lacks. */
  missingPermissions: z.array(z.string()),
});
export type EntraTestResponse = z.infer<typeof entraTestResponseSchema>;
