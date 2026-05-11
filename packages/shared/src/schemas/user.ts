// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

// `z.coerce.boolean()` calls JS `Boolean(v)` which returns true for any
// non-empty string — so `?enabled=false` would coerce to `true` and silently
// flip a filter into the opposite of what the operator selected. This helper
// parses common truthy/falsy strings explicitly and rejects garbage.
const queryBoolean = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const lower = v.trim().toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected a boolean' });
  return z.NEVER;
});

export const userSummarySchema = z.object({
  id: z.string(),
  samAccountName: z.string(),
  userPrincipalName: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  department: z.string().nullable(),
  title: z.string().nullable(),
  enabled: z.boolean(),
  locked: z.boolean(),
  passwordNeverExpires: z.boolean(),
  passwordExpiresAt: z.string().nullable(),
  accountExpiresAt: z.string().nullable(),
  lastLogonAt: z.string().nullable(),
  // AD's `whenChanged` — the most recent attribute modification on the
  // account. Useful as a "last touched" hint, including a rough proxy for
  // when a disabled account was disabled (with the caveat that any later
  // change resets it).
  modifiedAtSource: z.string().nullable(),
  // True when an Entra-cached photo exists for this user (cache row
  // present, absent flag false). Lets the SPA decide whether to render
  // <img> at all — without this, every avatar in a 50-row table would
  // fire a 404 photo request when no photos are cached. Always present;
  // false when no Entra integration is configured for the directory.
  hasPhoto: z.boolean(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const userDetailSchema = userSummarySchema.extend({
  givenName: z.string().nullable(),
  surname: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  managerDn: z.string().nullable(),
  // Manager DN resolved against user_cache_records. `id` is null when the
  // referenced manager is not in the cache; render the DN, no link. The
  // entire field is null when the user has no manager set in AD.
  manager: z
    .object({
      id: z.string().nullable(),
      distinguishedName: z.string(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  distinguishedName: z.string(),
  passwordLastSetAt: z.string().nullable(),
  // AD `badPasswordTime` — timestamp of the last failed sign-in attempt.
  // Surfaced on the detail view; not cached, so it's only available when
  // the live refresh runs.
  lastBadPasswordAt: z.string().nullable(),
  // True when AD's `adminCount` is 1 — i.e. SDProp has stamped this
  // account because it's currently or was previously a member of a
  // protected group (Domain Admins, Enterprise Admins, etc.). AD does NOT
  // clear adminCount when the user is removed from the group, so this is
  // a "handle with care" signal rather than ground truth — the UI tooltip
  // calls that out.
  isPrivileged: z.boolean(),
  // FILETIME of `lockoutTime` converted to ISO. Non-null when AD has an
  // active lockout stamp on the account. Note: AD does not always clear
  // lockoutTime when the lockout duration auto-expires, so a non-null value
  // here can co-exist with `locked=false` (we treat the successful bind as
  // the authoritative liveness signal).
  lockedAt: z.string().nullable(),
  // Computed = lockedAt + domain `lockoutDuration`. Null when the account
  // is not locked, when the domain policy is "manual unlock only"
  // (lockoutDuration = 0), or when we couldn't read the policy.
  autoUnlockAt: z.string().nullable(),
  // Additional typed AD attributes promoted into the Identity grid. All
  // sourced from rawAttributes at the route layer; we don't cache them as
  // separate columns because the detail view always live-refreshes first.
  employeeID: z.string().nullable(),
  employeeNumber: z.string().nullable(),
  ipPhone: z.string().nullable(),
  homePhone: z.string().nullable(),
  // homePostalAddress is technically a multi-valued LDAP type, but in
  // practice every AD setup we've seen stores a single multi-line string
  // (newline-separated). Treat as scalar; the UI uses a textarea for it.
  homePostalAddress: z.string().nullable(),
  description: z.string().nullable(),
  company: z.string().nullable(),
  // AD address attributes use single-letter names: c=country code,
  // co=country name, l=locality/city, st=state/province.
  c: z.string().nullable(),
  co: z.string().nullable(),
  l: z.string().nullable(),
  st: z.string().nullable(),
  postalCode: z.string().nullable(),
  // Multi-valued AD attributes; empty array if absent on the entry.
  otherMailbox: z.array(z.string()),
  otherHomePhone: z.array(z.string()),
  otherMobile: z.array(z.string()),
  // Read-only derived from proxyAddresses: every entry NOT prefixed with
  // uppercase `SMTP:` (the primary), with the case-insensitive `smtp:`
  // prefix stripped for display.
  emailAliases: z.array(z.string()),
  // directReports DNs resolved against user_cache_records. Entries with a
  // null id are users not currently in the cache — render the DN, no link.
  directReports: z.array(
    z.object({
      id: z.string().nullable(),
      distinguishedName: z.string(),
      displayName: z.string().nullable(),
    }),
  ),
  groupMemberships: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      distinguishedName: z.string(),
      direct: z.boolean(),
    }),
  ),
  freshness: z.object({
    cachedAt: z.string().nullable(),
    liveRefreshedAt: z.string().nullable(),
    isStale: z.boolean(),
  }),
  // Microsoft Entra (Graph) enrichment, populated only when an Entra
  // integration is configured for the directory. Null when the
  // integration is disabled or the runner hasn't yet pulled this user.
  // Photo presence lives on `hasPhoto` at the top level (inherited from
  // userSummarySchema) so search-list avatars can use it too.
  entra: z
    .object({
      lastSignInAt: z.string().nullable(),
      lastNonInteractiveSignInAt: z.string().nullable(),
      // Reflects the most recent signInActivity fetch outcome. 'p1_required'
      // tells the UI to show "requires Entra ID P1" copy instead of a
      // generic missing field.
      lastStatus: z.enum(['success', 'p1_required', 'forbidden', 'not_found']).nullable(),
      /**
       * MFA registration details from
       * /reports/authenticationMethods/userRegistrationDetails. All
       * fields are nullable because the report runner may not have
       * visited this user yet (or the tenant denied the report
       * endpoint).
       */
      mfa: z
        .object({
          isRegistered: z.boolean().nullable(),
          isCapable: z.boolean().nullable(),
          isPasswordlessCapable: z.boolean().nullable(),
          /** e.g. ['mobilePhone', 'microsoftAuthenticatorPush', 'fido2']. */
          methods: z.array(z.string()),
          /** Default MFA method; null when the user has none registered. */
          defaultMethod: z.string().nullable(),
          /** ISO timestamp of the last successful MFA report fetch. */
          fetchedAt: z.string().nullable(),
          /** 'success' | 'forbidden' | 'not_found' | 'p1_required'. */
          status: z.enum(['success', 'p1_required', 'forbidden', 'not_found']).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  // Every populated LDAP attribute on the user entry, with binary blobs
  // (objectGUID, photos, etc.) stripped at the provider layer. Each value is
  // a string or string[] in practice, but the schema is loose because AD
  // doesn't constrain the set we'll see across customer directories.
  rawAttributes: z.record(z.unknown()),
});
export type UserDetail = z.infer<typeof userDetailSchema>;

export const userSearchQuerySchema = z.object({
  q: z.string().max(256).optional(),
  enabled: queryBoolean.optional(),
  locked: queryBoolean.optional(),
  // Filter to accounts where DONT_EXPIRE_PASSWORD is set (true) or unset (false).
  passwordNeverExpires: queryBoolean.optional(),
  // Filter to accounts whose password expires within N days from now. The
  // route resolves the rotation horizon from the AD domain `maxPwdAge` at
  // request time.
  passwordExpiringInDays: z.coerce.number().int().min(0).max(3650).optional(),
  // Filter to accounts whose lastLogonAt is older than N days (or never).
  staleSinceDays: z.coerce.number().int().min(0).max(3650).optional(),
  // "Show me everyone with a problem right now": locked OR disabled OR
  // pwd-expired OR pwd-expiring within `issuesWithinDays`. Used by the
  // dashboard "Accounts needing attention" card. Default 14d.
  issues: queryBoolean.optional(),
  issuesWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  // Filter to accounts whose distinguishedName lives under this OU. When
  // includeSubOus=true (default) any descendant OU matches.
  ou: z.string().max(512).optional(),
  includeSubOus: queryBoolean.optional(),
  // Filter to direct members of this group (objectGUID). Multiple instances
  // of the param mean "AND" — must be in every listed group.
  inGroupId: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  // Case-insensitive department match. Exact equality, not substring — the
  // typical use is "show me Engineering" and substring matches make the OR
  // surprising.
  department: z.string().max(256).optional(),
  // Filter by manager (objectGUID of the manager user). The cache stores
  // manager_dn but the route resolves the GUID → DN before querying.
  managerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Cap raised to 50_000 so the web client can load the full dataset in
  // one request and filter/sort entirely in the browser. Mirrors the
  // CSV export cap on the same endpoint.
  pageSize: z.coerce.number().int().min(1).max(50_000).default(50),
  sort: z
    .enum([
      'displayName',
      'samAccountName',
      'userPrincipalName',
      'email',
      'department',
      'title',
      'lastLogonAt',
      'passwordExpiresAt',
      'accountExpiresAt',
      'modifiedAtSource',
      // `status` orders by a derived priority: locked → disabled → expired
      // → pwd-expired → pwd-expiring → active. The route translates it into
      // a CASE expression; ASC = most-attention-needed first.
      'status',
    ])
    .default('displayName'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;

export const userSearchResponseSchema = z.object({
  rows: z.array(userSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>;

// All write request bodies dropped their `password` field once the server
// started caching the step-up bind password in process memory keyed by
// elevated_session_id (see apps/api/src/services/credentialCache.ts). The
// step-up flow gates every write; the cached password is what binds to AD
// per request. Clients only need to send the change details now.

export const unlockUserRequestSchema = z.object({}).strict();
export type UnlockUserRequest = z.infer<typeof unlockUserRequestSchema>;

export const confirmPasswordSchema = z.object({}).strict();

export const resetPasswordRequestSchema = z.object({
  newPassword: z.string().min(8).max(1024),
  forceChangeAtNextLogin: z.boolean().default(true),
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const groupMembershipChangeSchema = z.object({
  groupId: z.string().uuid(),
});
export type GroupMembershipChangeRequest = z.infer<typeof groupMembershipChangeSchema>;

// User attribute patch — keys match the camelCase fields on UserDetail.
// Each field is optional; null clears the attribute; a non-empty string
// replaces it. The route validates max length per field.
const editableStringField = z.string().max(256).nullable();
// Multi-valued attributes (otherMailbox, otherHomePhone, otherMobile).
//   null / undefined  → not in patch / delete the attribute
//   []                → also a delete (no values)
//   [a, b, …]         → replace all values
const editableArrayField = z.array(z.string().max(256)).max(50).nullable();
// `.strict()` here is the writable-attribute allow-list. Reserved attributes
// like `memberOf`, `userAccountControl`, `objectSid`, `objectGUID`, and
// `nTSecurityDescriptor` are deliberately absent and `.strict()` rejects them
// loudly rather than silently dropping them. Membership and UAC flags have
// dedicated endpoints with their own validation.
export const userUpdateRequestSchema = z.object({
  patch: z
    .object({
      displayName: editableStringField.optional(),
      givenName: editableStringField.optional(),
      surname: editableStringField.optional(),
      email: z
        .string()
        .email()
        .nullable()
        .optional()
        .or(z.literal('').transform(() => null)),
      phone: editableStringField.optional(),
      mobile: editableStringField.optional(),
      title: editableStringField.optional(),
      department: editableStringField.optional(),
      employeeID: editableStringField.optional(),
      employeeNumber: editableStringField.optional(),
      ipPhone: editableStringField.optional(),
      homePhone: editableStringField.optional(),
      // homePostalAddress and description are multi-line freeform fields;
      // bump the limit so paragraph-style values don't get rejected.
      homePostalAddress: z.string().max(1024).nullable().optional(),
      description: z.string().max(1024).nullable().optional(),
      company: editableStringField.optional(),
      c: z.string().max(8).nullable().optional(),
      co: editableStringField.optional(),
      l: editableStringField.optional(),
      st: editableStringField.optional(),
      postalCode: editableStringField.optional(),
      otherMailbox: editableArrayField.optional(),
      otherHomePhone: editableArrayField.optional(),
      otherMobile: editableArrayField.optional(),
    })
    .strict()
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must contain at least one field' }),
});
export type UserUpdateRequest = z.infer<typeof userUpdateRequestSchema>;

// ---- Directory policy --------------------------------------------------
//
// Domain-wide security policy read from the AD root object. Surfaced in
// Settings and used to compute auto-unlock timestamps in the user detail.
// All values are nullable: AD may not publish them to a non-privileged
// reader, in which case we still want to return the rest of the directory
// info rather than failing.
export const directoryPolicySchema = z.object({
  // `lockoutDuration` in minutes. 0 = manual unlock only. Null = unknown.
  lockoutDurationMinutes: z.number().int().nullable(),
  // `lockoutThreshold` — bad-password attempts before AD locks the account.
  // 0 = lockout disabled. Null = unknown.
  lockoutThreshold: z.number().int().nullable(),
  // `lockoutObservationWindow` in minutes — the rolling window over which
  // bad-password counts accumulate before resetting.
  lockoutObservationMinutes: z.number().int().nullable(),
  // `maxPwdAge` in days. 0 = passwords never expire by domain policy. Null
  // = unknown. This is the authoritative source the API uses to compute
  // each user's `passwordExpiresAt`. Fine-grained password policies (PSOs)
  // can override this per user/group; PSO resolution is not implemented
  // yet, so PSO-covered users will reflect the domain default here.
  maxPwdAgeDays: z.number().int().nullable(),
  // `minPwdLength` — minimum password length enforced by the domain.
  minPwdLength: z.number().int().nullable(),
  // `pwdHistoryLength` — how many past passwords AD remembers.
  pwdHistoryLength: z.number().int().nullable(),
  // ISO timestamp of when this policy was last fetched from AD.
  fetchedAt: z.string(),
});
export type DirectoryPolicy = z.infer<typeof directoryPolicySchema>;
