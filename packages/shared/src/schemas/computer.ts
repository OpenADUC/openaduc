// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

const queryBoolean = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const lower = v.trim().toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected a boolean' });
  return z.NEVER;
});

export const computerSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  samAccountName: z.string().nullable(),
  distinguishedName: z.string(),
  dnsHostName: z.string().nullable(),
  operatingSystem: z.string().nullable(),
  operatingSystemVersion: z.string().nullable(),
  enabled: z.boolean(),
  lastLogonAt: z.string().nullable(),
  // AD's whenChanged on the computer object — useful as a "last touched"
  // hint distinct from logon.
  modifiedAtSource: z.string().nullable(),
});
export type ComputerSummary = z.infer<typeof computerSummarySchema>;

export const computerSearchQuerySchema = z.object({
  q: z.string().max(256).optional(),
  enabled: queryBoolean.optional(),
  // Exact match on the operatingSystem attribute (e.g. "Windows 10 Enterprise").
  // Substring search uses `q` instead.
  operatingSystem: z.string().max(256).optional(),
  // Filter to computers whose lastLogonAt is older than N days (or never).
  staleSinceDays: z.coerce.number().int().min(0).max(3650).optional(),
  ou: z.string().max(512).optional(),
  includeSubOus: queryBoolean.optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Cap raised to 50_000 so the web client can load the full dataset
  // in one request and filter/sort entirely in the browser. Mirrors
  // the user export cap. Auth-gated; not a public endpoint.
  pageSize: z.coerce.number().int().min(1).max(50_000).default(50),
  sort: z
    .enum([
      'name',
      'samAccountName',
      'dnsHostName',
      'operatingSystem',
      'lastLogonAt',
      'modifiedAtSource',
    ])
    .default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type ComputerSearchQuery = z.infer<typeof computerSearchQuerySchema>;

export const computerSearchResponseSchema = z.object({
  rows: z.array(computerSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ComputerSearchResponse = z.infer<typeof computerSearchResponseSchema>;

export const computerDetailSchema = computerSummarySchema.extend({
  description: z.string().nullable(),
  managedByDn: z.string().nullable(),
  // Resolved from managedByDn against user_cache_records when possible.
  managedBy: z
    .object({
      id: z.string().nullable(),
      distinguishedName: z.string(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  passwordLastSetAt: z.string().nullable(),
  createdAtSource: z.string().nullable(),
  // Direct group memberships, resolved against group_cache_records where
  // possible. Same shape the user detail uses.
  groupMemberships: z.array(
    z.object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      distinguishedName: z.string(),
    }),
  ),
  freshness: z.object({
    cachedAt: z.string().nullable(),
    isStale: z.boolean(),
  }),
  rawAttributes: z.record(z.unknown()),
});
export type ComputerDetail = z.infer<typeof computerDetailSchema>;

// ---- Deleted computers (lazy LDAP query, no cache) ----------------------

export const deletedComputerSummarySchema = z.object({
  id: z.string(),
  cn: z.string().nullable(),
  samAccountName: z.string().nullable(),
  dnsHostName: z.string().nullable(),
  operatingSystem: z.string().nullable(),
  deletedDn: z.string(),
  lastKnownParent: z.string().nullable(),
  deletedAt: z.string().nullable(),
  recycled: z.boolean(),
});
export type DeletedComputerSummary = z.infer<typeof deletedComputerSummarySchema>;

export const deletedComputerSearchQuerySchema = z.object({
  q: z.string().max(256).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DeletedComputerSearchQuery = z.infer<typeof deletedComputerSearchQuerySchema>;

export const deletedComputerSearchResponseSchema = z.object({
  rows: z.array(deletedComputerSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type DeletedComputerSearchResponse = z.infer<typeof deletedComputerSearchResponseSchema>;

export const deletedComputerDetailSchema = deletedComputerSummarySchema.extend({
  rawAttributes: z.record(z.unknown()),
});
export type DeletedComputerDetail = z.infer<typeof deletedComputerDetailSchema>;
