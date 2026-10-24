// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// Issuing a Temporary Access Pass (TAP) to a user from their page. The
// tenant's TAP policy, read from Graph, bounds what can be asked for; the
// pass's value appears only in the issue response, once.

/** Graph's own bounds on any pass's lifetime, whatever the tenant allows. */
export const TAP_LIFETIME_BOUNDS = { min: 10, max: 43_200 } as const;

export const tapPolicySchema = z.object({
  defaultLifetimeMinutes: z.number().int(),
  minLifetimeMinutes: z.number().int(),
  maxLifetimeMinutes: z.number().int(),
  /** The tenant makes every pass one-time; otherwise the operator chooses. */
  usableOnceOnly: z.boolean(),
});
export type TapPolicy = z.infer<typeof tapPolicySchema>;

/** The pass a user already holds. Graph never returns its value again. */
export const existingTapSchema = z.object({
  createdAt: z.string().nullable(),
  startsAt: z.string().nullable(),
  lifetimeMinutes: z.number().int().nullable(),
  isUsableOnce: z.boolean().nullable(),
  isUsable: z.boolean().nullable(),
  /** Graph's methodUsabilityReason, e.g. `NotYetValid`, `Expired`, `EnabledByPolicy`. */
  usabilityReason: z.string().nullable(),
});
export type ExistingTap = z.infer<typeof existingTapSchema>;

export const tapRefusalReasonSchema = z.enum([
  /** In a group AD protects, or one mapped to OpenADUC's admin role. */
  'privileged',
  /** Holds a Microsoft Entra administrator role. */
  'entraAdminRole',
  /** The user's groups couldn't be read, so they can't be cleared. */
  'membershipUnknown',
  /** The tenant has Temporary Access Pass turned off. */
  'policyDisabled',
]);
export type TapRefusalReason = z.infer<typeof tapRefusalReasonSchema>;

/** Whether a pass can be issued to this user, and within what limits. */
export const tapPreflightSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    policy: tapPolicySchema,
    existing: existingTapSchema.nullable(),
  }),
  z.object({
    status: z.literal('refused'),
    reason: tapRefusalReasonSchema,
    message: z.string(),
  }),
  /** Not in Entra yet. Connect Sync runs on its own schedule; it can't be started from here. */
  z.object({
    status: z.literal('unsynced'),
    /** When the tenant last synced from AD; null when it never has or couldn't be read. */
    lastSyncAt: z.string().nullable(),
  }),
]);
export type TapPreflight = z.infer<typeof tapPreflightSchema>;

export const tapIssueRequestSchema = z.object({
  /** null starts it now. */
  startsAt: z.string().datetime({ offset: true }).nullable(),
  lifetimeMinutes: z.number().int().min(TAP_LIFETIME_BOUNDS.min).max(TAP_LIFETIME_BOUNDS.max),
  isUsableOnce: z.boolean(),
  /** The operator was warned that this replaces the pass the user holds. */
  replaceExisting: z.boolean().default(false),
});
export type TapIssueRequest = z.input<typeof tapIssueRequestSchema>;

export const tapIssueResponseSchema = z.object({
  /** The pass itself. Shown once; OpenADUC keeps no copy. */
  temporaryAccessPass: z.string(),
  startsAt: z.string(),
  expiresAt: z.string(),
  lifetimeMinutes: z.number().int(),
  isUsableOnce: z.boolean(),
  replaced: z.boolean(),
});
export type TapIssueResponse = z.infer<typeof tapIssueResponseSchema>;
