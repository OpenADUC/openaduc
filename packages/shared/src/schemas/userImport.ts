// SPDX-License-Identifier: BUSL-1.1
// Importing users from a spreadsheet: what the wizard checks the rows
// against (the people already in the directory), the import as the final
// check judges it and the run will make it, and the placement rules that
// remember where each bucket went.
import { z } from 'zod';
import { directoryCountry } from '../country.js';
import type { BulkJob, BulkJobRowStatus } from './bulkJob.js';
import {
  CONTROL_CHARS,
  RESET_PASSWORD_MIN_LENGTH,
  samAccountNameSchema,
  userPrincipalNameSchema,
} from './user.js';
import {
  AD_TEXT_LIMITS,
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

/** The longest each field can be: its AD attribute's limit, or a lookup's. */
export const IMPORT_FIELD_MAX: Partial<Record<ImportField, number>> = {
  first: AD_TEXT_LIMITS.givenName,
  last: AD_TEXT_LIMITS.sn,
  // Feeds the display name only.
  preferredFirst: AD_TEXT_LIMITS.givenName,
  displayName: AD_TEXT_LIMITS.displayName,
  employeeId: AD_TEXT_LIMITS.employeeID,
  email: AD_TEXT_LIMITS.mail,
  personalEmail: AD_TEXT_LIMITS.otherMailbox,
  title: AD_TEXT_LIMITS.title,
  department: AD_TEXT_LIMITS.department,
  company: AD_TEXT_LIMITS.company,
  office: AD_TEXT_LIMITS.physicalDeliveryOfficeName,
  officePhone: AD_TEXT_LIMITS.telephoneNumber,
  mobile: AD_TEXT_LIMITS.mobile,
  // Matched against mail, UPN or sAMAccountName.
  manager: AD_TEXT_LIMITS.mail,
  description: AD_TEXT_LIMITS.description,
};
const max = (field: ImportField) => IMPORT_FIELD_MAX[field]!;

/** The rows whose managers, followed within the import, lead back to them. */
export function managerLoops(managerOf: ReadonlyMap<number, number>): Set<number> {
  const looped = new Set<number>();
  for (const start of managerOf.keys()) {
    const seen = new Set<number>([start]);
    for (let at = managerOf.get(start); at !== undefined; at = managerOf.get(at)) {
      if (at === start) {
        looped.add(start);
        break;
      }
      if (seen.has(at)) break;
      seen.add(at);
    }
  }
  return looped;
}

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

const address = z.string().trim().email().max(max('email')).nullable().optional();

/** One account to create, its names as the operator approved them. */
export const importRowSchema = z
  .object({
    /** Its row in the spreadsheet, the header being row 1. */
    line: z.number().int().min(2),
    ouDn: z.string().trim().min(1).max(512),
    givenName: directoryText(max('first')).min(1),
    surname: directoryText(max('last')).min(1),
    initials: optionalDirectoryText(AD_TEXT_LIMITS.initials),
    displayName: directoryText(max('displayName')).min(1),
    cn: directoryText(AD_TEXT_LIMITS.cn).min(1),
    samAccountName: samAccountNameSchema,
    userPrincipalName: userPrincipalNameSchema.refine((v) => !CONTROL_CHARS.test(v), {
      message: 'cannot contain control characters',
    }),
    /** Written to `mail` in place of the UPN. */
    email: address,
    /** Written to `otherMailbox`. */
    personalEmail: address,
    mobile: optionalDirectoryText(max('mobile')),
    telephoneNumber: optionalDirectoryText(max('officePhone')),
    keepPhonesAsTyped: z.array(z.enum(PHONE_FIELDS)).max(PHONE_FIELDS.length).optional(),
    employeeId: optionalDirectoryText(max('employeeId')),
    description: optionalDirectoryLines(max('description')),
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
    const managerOf = new Map<number, number>();
    body.rows.forEach((row, i) => {
      if (row.managerRow !== undefined) managerOf.set(i, row.managerRow);
    });
    for (const i of managerLoops(managerOf)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', i, 'managerRow'],
        message: 'its managers go round in a loop',
      });
    }
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
export type CheckedImportRequest = z.output<typeof importRequestSchema>;

// ---- The run ------------------------------------------------------------

/**
 * What an import does for each row, in this order: create the account
 * disabled, set its password, enable it if asked, add it to its bucket's
 * groups, set its manager. Follow-ups that need the account (a Temporary
 * Access Pass) come after.
 */
export const IMPORT_STEPS = ['create', 'password', 'enable', 'groups', 'manager'] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

/** Running an import: the request the final check passed. */
export const importRunRequestSchema = z
  .object({
    import: importRequestSchema,
    /** The operator ticked that rows going in groups AD protects gain admin rights. */
    acknowledgeProtected: z.boolean().default(false),
  })
  .strict();
export type ImportRunRequest = z.input<typeof importRunRequestSchema>;

/** How long an import holds its passwords for the results CSV, unless downloaded first. */
export const IMPORT_PASSWORDS_HELD_HOURS = 24;

/** One row of an import's job, as its results show it. */
export interface ImportJobRow {
  /** Its row in the spreadsheet. */
  line: number;
  displayName: string;
  samAccountName: string;
  userPrincipalName: string;
  status: BulkJobRowStatus;
  /** The account's objectGUID, once it's created. */
  id: string | null;
  completed: ImportStep[];
  /** The steps that failed, each saying why (a group step names the groups). */
  failed: { step: ImportStep; message: string }[];
  errorMessage: string | null;
}

/**
 * Whether the results CSV holds the passwords: `none` in random mode;
 * `held` until the operator downloads it (once), or until it expires.
 */
export type ImportPasswordsState = 'none' | 'held' | 'downloaded' | 'expired';

export interface ImportJobResponse {
  job: BulkJob;
  rows: ImportJobRow[];
  results: {
    passwords: ImportPasswordsState;
    downloadedAt: string | null;
    /** When held passwords are purged; null in random mode. */
    expiresAt: string | null;
  };
}

/** The results CSV, as the browser saves it. */
export interface ImportResultsDownload {
  fileName: string;
  csv: string;
}

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
