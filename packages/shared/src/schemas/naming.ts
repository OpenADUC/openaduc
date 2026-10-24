// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import type { NamingSettings, NamingSuggestion } from '../naming.js';

// Room for an import's 500 rows in one check.
export const NAMING_CHECK_MAX = 500;

const namePart = z.string().trim().max(64);

export const personNameSchema = z.object({
  first: namePart.min(1),
  last: namePart.min(1),
  middleInitial: namePart.nullable().optional(),
  preferredFirst: namePart.nullable().optional(),
});

const typedName = z.string().trim().max(256).nullable().optional();

// Names the operator typed in place of the pattern's (see NameOverrides).
export const nameOverridesSchema = z.object({
  samAccountName: typedName,
  userPrincipalName: typedName,
  displayName: typedName,
});

export const namingCheckRequestSchema = z.object({
  names: z
    .array(
      personNameSchema.extend({
        ouDn: z.string().trim().min(1).max(512).optional(),
        overrides: nameOverridesSchema.optional(),
      }),
    )
    .min(1)
    .max(NAMING_CHECK_MAX),
});
export type NamingCheckRequest = z.infer<typeof namingCheckRequestSchema>;

export interface NamingCheckResponse {
  naming: NamingSettings;
  /** One per requested name, in order. */
  suggestions: NamingSuggestion[];
}

// Check the pattern with namingPatternProblem, which says what's wrong.
export const namingSettingsSchema = z.object({
  pattern: z.string().trim(),
  upnSuffix: z.string().trim().toLowerCase().min(1).max(255),
});

export interface NamingSettingsResponse {
  naming: NamingSettings;
  /** The domain's DNS name first, then the forest's extra UPN suffixes. */
  upnSuffixes: string[];
}
