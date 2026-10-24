// SPDX-License-Identifier: BUSL-1.1
// Importing users from a spreadsheet: what the wizard checks the rows
// against (the people already in the directory), the import as the final
// check judges it and the run will make it, and the placement rules that
// remember where each bucket went.
import { z } from 'zod';
import { directoryCountry } from '../country.js';
import {
  CONTROL_CHARS,
  RESET_PASSWORD_MIN_LENGTH,
  samAccountNameSchema,
  userPrincipalNameSchema,
} from './user.js';
import {
  PHONE_FIELDS,
  directoryText,
  newUserGroupsSchema,
  newUserOrganisationSchema,
  optionalDirectoryLines,
  optionalDirectoryText,
} from './userCreate.js';

export const IMPORT_MAX_ROWS = 500;

/**
 * What a column can be imported as: a fixed list, so a spreadsheet can't
 * write raw LDAP attributes.
 */
export const IMPORT_FIELDS = [
  'first',
  'last',
  'middleInitial',
  'preferredFirst',
  'displayName',
  'employeeId',
  'email',
  'personalEmail',
  'title',
  'department',
  'company',
  'office',
  'officePhone',
  'mobile',
  'manager',
  'description',
  'usageLocation',
  'startDate',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

// ---- Looking people up ------------------------------------------------

/**
 * Who in the directory holds these employee IDs, or these addresses or
 * logon names (mail, SMTP proxy address, UPN or sAMAccountName): the rows
 * that are people already there, and the managers rows name.
 */
export const importLookupRequestSchema = z
  .object({
    employeeIds: z.array(z.string().trim().min(1).max(64)).max(IMPORT_MAX_ROWS),
    identifiers: z.array(z.string().trim().min(1).max(256)).max(IMPORT_MAX_ROWS * 2),
  })
  .strict();
export type ImportLookupRequest = z.infer<typeof importLookupRequestSchema>;

export interface ImportPerson {
  id: string;
  distinguishedName: string;
  samAccountName: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
  employeeId: string | null;
  /** mail and the SMTP proxy addresses, without `smtp:`. */
  addresses: string[];
}

export interface ImportLookupResponse {
  people: ImportPerson[];
}

// ---- The import -------------------------------------------------------

/**
 * `generate` gives each account its own password, made by the server so
 * the run can hand them over; `set` gives every account the one typed.
 */
export const importPasswordSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('random') }).strict(),
  z.object({ mode: z.literal('generate'), mustChange: z.boolean() }).strict(),
  z
    .object({
      mode: z.literal('set'),
      password: z.string().min(RESET_PASSWORD_MIN_LENGTH).max(256),
      mustChange: z.boolean(),
    })
    .strict(),
]);
export type ImportPassword = z.infer<typeof importPasswordSchema>;

const address = z.string().trim().email().max(256).nullable().optional();

/** One account to create, its names as the operator approved them. */
export const importRowSchema = z
  .object({
    /** Its row in the spreadsheet, the header being row 1. */
    line: z.number().int().min(2),
    ouDn: z.string().trim().min(1).max(512),
    givenName: directoryText(64).min(1),
    surname: directoryText(64).min(1),
    initials: optionalDirectoryText(6),
    displayName: directoryText(256).min(1),
    cn: directoryText(64).min(1),
    samAccountName: samAccountNameSchema,
    userPrincipalName: userPrincipalNameSchema.refine((v) => !CONTROL_CHARS.test(v), {
      message: 'cannot contain control characters',
    }),
    /** Written to `mail` in place of the UPN. */
    email: address,
    /** Written to `otherMailbox`. */
    personalEmail: address,
    mobile: optionalDirectoryText(64),
    telephoneNumber: optionalDirectoryText(64),
    keepPhonesAsTyped: z.array(z.enum(PHONE_FIELDS)).max(PHONE_FIELDS.length).optional(),
    employeeId: optionalDirectoryText(16),
    description: optionalDirectoryLines(1024),
    /** A two-letter country code. */
    usageLocation: z
      .string()
      .length(2)
      .refine((c) => directoryCountry(c) !== null, { message: 'is not a country code' })
      .nullable()
      .optional(),
    startDate: z.iso.date().nullable().optional(),
    /** Title, department, company, office, and a manager already in the directory. */
    organisation: newUserOrganisationSchema.optional(),
    /** A manager created by this import: the index of their row here. */
    managerRow: z.number().int().min(0).optional(),
    /** The bucket's groups. */
    groups: newUserGroupsSchema.optional(),
  })
  .strict();
export type ImportRow = z.input<typeof importRowSchema>;

export const importRequestSchema = z
  .object({
    rows: z.array(importRowSchema).min(1).max(IMPORT_MAX_ROWS),
    password: importPasswordSchema,
    enabled: z.boolean(),
    /** Set `mail` to the UPN for rows without an email. */
    mailFromUpn: z.boolean(),
  })
  .strict()
  .superRefine((body, ctx) => {
    body.rows.forEach((row, i) => {
      if (row.managerRow === undefined) return;
      if (row.managerRow >= body.rows.length || row.managerRow === i) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'managerRow'],
          message: 'must be another row of the import',
        });
      }
      if (row.organisation?.managerId) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'managerRow'],
          message: 'a row has one manager',
        });
      }
    });
  });
export type ImportRequest = z.input<typeof importRequestSchema>;

export type ImportCheckIssueKind =
  | 'unusable'
  | 'taken'
  | 'duplicate'
  | 'existing'
  | 'ou_missing'
  | 'group_missing'
  | 'role_group'
  | 'manager_missing'
  | 'password'
  | 'phone';

export interface ImportCheckIssue {
  /** The index of the row in the request, or null for what isn't one row's. */
  row: number | null;
  kind: ImportCheckIssueKind;
  message: string;
}

/** The final check: the import against the directory as it is right before the run. */
export interface ImportCheckResponse {
  checkedAt: string;
  /** What stops the run. */
  problems: ImportCheckIssue[];
  /** What the run goes ahead despite. */
  warnings: ImportCheckIssue[];
  /** Groups AD protects that rows go in: the run needs the operator's acknowledgement. */
  protectedGroups: { id: string; name: string }[];
}

// ---- Placement rules --------------------------------------------------

export const placementRuleInputSchema = z
  .object({
    /** The column the import grouped by. */
    column: z.enum(IMPORT_FIELDS),
    /** The bucket's value; empty for the blank bucket. */
    value: z.string().trim().max(256),
    ouDn: z.string().trim().min(1).max(512),
    groupIds: newUserGroupsSchema,
  })
  .strict();
export type PlacementRuleInput = z.infer<typeof placementRuleInputSchema>;

export const placementRulesSaveSchema = z
  .object({ rules: z.array(placementRuleInputSchema).min(1).max(IMPORT_MAX_ROWS) })
  .strict();
export type PlacementRulesSave = z.infer<typeof placementRulesSaveSchema>;

export interface PlacementRule {
  column: ImportField;
  value: string;
  ouDn: string;
  /** The groups still in the directory cache; a deleted group drops out. */
  groups: { id: string; name: string }[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface PlacementRulesResponse {
  rules: PlacementRule[];
}

export interface PlacementRulesSaveResponse extends PlacementRulesResponse {
  /** How many rules the save added or changed. */
  changed: number;
}
