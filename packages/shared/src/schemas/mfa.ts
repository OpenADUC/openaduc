// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// MFA registration snapshot for the Audit-side view across all users
// in a directory. One row per user the entra.mfa.registration runner
// has visited; sourced from /reports/authenticationMethods.

export const mfaRegistrationStatusSchema = z.enum([
  'all',
  'registered',
  'capable_not_registered',
  'not_capable',
]);
export type MfaRegistrationStatus = z.infer<typeof mfaRegistrationStatusSchema>;

export const mfaRegistrationRowSchema = z.object({
  /** AD objectGuid of the user. Click target for opening the user detail. */
  userObjectGuid: z.string(),
  userPrincipalName: z.string().nullable(),
  userDisplayName: z.string().nullable(),
  samAccountName: z.string().nullable(),
  department: z.string().nullable(),
  /** True = at least one MFA method registered. Null when unknown / not yet fetched. */
  isMfaRegistered: z.boolean().nullable(),
  /** True = tenant policy allows this user to register MFA. */
  isMfaCapable: z.boolean().nullable(),
  /** True = passwordless methods (FIDO2, Windows Hello, etc.) registered. */
  isPasswordlessCapable: z.boolean().nullable(),
  /** Method strings from Graph (e.g. 'mobilePhone', 'microsoftAuthenticatorPush'). */
  methods: z.array(z.string()),
  defaultMethod: z.string().nullable(),
  /** ISO timestamp of the most recent MFA report fetch. */
  fetchedAt: z.string().nullable(),
});
export type MfaRegistrationRow = z.infer<typeof mfaRegistrationRowSchema>;

export const mfaRegistrationResponseSchema = z.object({
  rows: z.array(mfaRegistrationRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type MfaRegistrationResponse = z.infer<typeof mfaRegistrationResponseSchema>;
