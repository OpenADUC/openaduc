// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// Microsoft Entra sign-in event, shaped by the API from a local cache
// table populated by a delta-sync runner. Filtering happens server-side
// on indexed columns; the SPA passes filter params through and the
// server returns paginated, ordered results. The detail-level fields
// not promoted to columns ride along on the per-event detail endpoint
// (powering the row-detail modal) — see signInEventDetailSchema below.

export const signInEventSchema = z.object({
  /** Local DB id (string for SPA stability across page reloads). */
  id: z.string(),
  /** Graph's event id; unique per provider. */
  entraEventId: z.string(),
  /** ISO timestamp of when the sign-in attempt was recorded. */
  createdDateTime: z.string(),
  /** Resolved AD objectGuid. Null when the user is cloud-only. */
  userObjectGuid: z.string().nullable(),
  entraUserId: z.string().nullable(),
  userPrincipalName: z.string().nullable(),
  userDisplayName: z.string().nullable(),
  appId: z.string().nullable(),
  appDisplayName: z.string().nullable(),
  /**
   * Source IP recorded by Entra. Either IPv4 or IPv6 — Graph stores
   * exactly one address per event (whichever the client connected
   * with). It does not return both forms.
   */
  ipAddress: z.string().nullable(),
  /** 'Browser' | 'Mobile Apps and Desktop clients' | 'Exchange ActiveSync' | … */
  clientAppUsed: z.string().nullable(),
  /** 'success' | 'failure' | 'notApplied' | 'notAuthorized' | 'unknownFutureValue'. */
  conditionalAccessStatus: z.string().nullable(),
  /** True for browser sign-ins, false for token-refresh / service flows. */
  isInteractive: z.boolean().nullable(),
  status: z
    .object({
      /** 0 = success; non-zero = Entra-specific failure code. */
      errorCode: z.number(),
      failureReason: z.string().nullable(),
    })
    .nullable(),
  device: z
    .object({
      os: z.string().nullable(),
      browser: z.string().nullable(),
      /** 'AzureAd' | 'Workplace' | 'ServerAd' | null. */
      trustType: z.string().nullable(),
    })
    .nullable(),
  location: z
    .object({
      city: z.string().nullable(),
      state: z.string().nullable(),
      countryOrRegion: z.string().nullable(),
    })
    .nullable(),
  /**
   * Authentication methods that *succeeded* during this sign-in.
   * Examples: 'Password', 'Mobile app notification', 'FIDO2 security key'.
   */
  authenticationMethods: z.array(z.string()),
  riskState: z.string().nullable(),
  riskLevel: z.string().nullable(),
});
export type SignInEvent = z.infer<typeof signInEventSchema>;

export const signInEventsResponseSchema = z.object({
  events: z.array(signInEventSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type SignInEventsResponse = z.infer<typeof signInEventsResponseSchema>;

// Detail-level event for the row-detail modal. Adds the catch-all
// `detail` object holding everything not promoted to columns
// (additionalDetails, conditionalAccessPolicies, raw
// authenticationDetails with timestamps and step requirements, etc.).
export const signInEventDetailSchema = signInEventSchema.extend({
  /** Full Graph payload of fields not promoted to columns. */
  detail: z.record(z.unknown()),
  fetchedAt: z.string(),
});
export type SignInEventDetail = z.infer<typeof signInEventDetailSchema>;

export const signInEventAppSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
});
export type SignInEventApp = z.infer<typeof signInEventAppSchema>;
