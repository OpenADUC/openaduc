// SPDX-License-Identifier: BUSL-1.1
// Creating a user: the directory's defaults for new accounts, the create
// request, and how far a create got.
import { z } from 'zod';
import type { Role } from '../capabilities.js';
import { isPhoneCountry } from '../phone.js';
import {
  CONTROL_CHARS,
  RESET_PASSWORD_MIN_LENGTH,
  samAccountNameSchema,
  userPrincipalNameSchema,
} from './user.js';

// ---- Directory defaults ------------------------------------------------

/**
 * `random`: a long password nobody sees, for people who set their own in
 * Entra (SSPR with writeback, or a Temporary Access Pass). `generate`: one
 * the operator is shown once. `set`: one the operator types.
 */
export const PASSWORD_MODES = ['random', 'generate', 'set'] as const;
export type PasswordMode = (typeof PASSWORD_MODES)[number];

export const newUserSettingsSchema = z
  .object({
    /** Set `mail` to the UPN. `proxyAddresses` is never written. */
    mailFromUpn: z.boolean(),
    passwordMode: z.enum(PASSWORD_MODES),
    /** The country a phone number written without a country code is in. */
    phoneCountry: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isPhoneCountry, { message: 'is not a country code' })
      .nullable(),
  })
  .strict();
export type NewUserSettings = z.infer<typeof newUserSettingsSchema>;

export const DEFAULT_NEW_USER_SETTINGS: NewUserSettings = {
  mailFromUpn: true,
  passwordMode: 'random',
  phoneCountry: null,
};

export interface NewUserSettingsResponse {
  newUsers: NewUserSettings;
}

// ---- Create ------------------------------------------------------------

/**
 * AD's order: the account is created disabled, then given a password,
 * then added to its groups, then enabled. Enabling comes last so nobody
 * signs in to an account still missing what the create meant to give it.
 */
export const USER_CREATE_STEPS = ['create', 'password', 'groups', 'enable'] as const;
export type UserCreateStep = (typeof USER_CREATE_STEPS)[number];

/** The steps a create runs: less the groups when there are none, and enabling when it stays disabled. */
export function plannedSteps(enabled: boolean, groups: boolean): UserCreateStep[] {
  return USER_CREATE_STEPS.filter((s) => (s !== 'enable' || enabled) && (s !== 'groups' || groups));
}

export function remainingSteps(
  planned: readonly UserCreateStep[],
  completed: readonly UserCreateStep[],
): UserCreateStep[] {
  return planned.filter((s) => !completed.includes(s));
}

export const PHONE_FIELDS = ['mobile', 'telephoneNumber'] as const;
export type PhoneField = (typeof PHONE_FIELDS)[number];

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), { message: 'cannot contain control characters' });
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .optional()
    .transform((v) => v || null);
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS_BUT_NEWLINES = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;
const optionalLines = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !CONTROL_CHARS_BUT_NEWLINES.test(v), {
      message: 'cannot contain control characters',
    })
    .nullable()
    .optional()
    .transform((v) => v || null);

/**
 * The organisation attributes copying a user carries over: ADUC's
 * (department, company, manager and the address but the street) and
 * title, office and street, which a template user's team shares too.
 * The country is three attributes (c, co, countryCode) that travel
 * together, so Entra Connect sees one country.
 */
export const NEW_USER_ORGANISATION_FIELDS = [
  'title',
  'department',
  'company',
  'physicalDeliveryOfficeName',
  'streetAddress',
  'l',
  'st',
  'postalCode',
  'c',
  'co',
  'countryCode',
] as const;
export type NewUserOrganisationField = (typeof NEW_USER_ORGANISATION_FIELDS)[number];

// AD's own upper bounds for each attribute.
export const newUserOrganisationSchema = z
  .object({
    title: optionalText(128),
    department: optionalText(64),
    company: optionalText(64),
    physicalDeliveryOfficeName: optionalText(128),
    /** Multi-line, as ADUC's Street box. */
    streetAddress: optionalLines(1024),
    l: optionalText(128),
    st: optionalText(128),
    postalCode: optionalText(40),
    /** The two-letter country code. */
    c: optionalText(3),
    /** The country's name. */
    co: optionalText(128),
    /** The country's ISO 3166 number. */
    countryCode: optionalText(3).refine((v) => v === null || /^\d+$/.test(v), {
      message: 'must be a number',
    }),
    /** The manager's objectGUID. */
    managerId: z.guid().nullable().optional(),
  })
  .strict()
  // Only what has a value is written; the rest is left unset.
  .transform(({ managerId, ...fields }) => ({
    attributes: Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as Partial<
      Record<NewUserOrganisationField, string>
    >,
    managerId: managerId ?? null,
  }));
export type NewUserOrganisation = z.input<typeof newUserOrganisationSchema>;

/** More than any template user is in; it bounds one create's writes. */
export const MAX_NEW_USER_GROUPS = 200;

/**
 * The password a new account gets. In `random` mode the server makes it
 * and nobody sees it; must-change is off, because `pwdLastSet=0` stops a
 * synced user signing in to Entra unless Connect Sync's force-change flag
 * is on.
 */
export const userCreatePasswordSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('random') }).strict(),
  z
    .object({
      mode: z.enum(['generate', 'set']),
      password: z.string().min(RESET_PASSWORD_MIN_LENGTH).max(256),
      mustChange: z.boolean(),
    })
    .strict(),
]);
export type UserCreatePassword = z.infer<typeof userCreatePasswordSchema>;

export const userCreateRequestSchema = z
  .object({
    ouDn: z.string().trim().min(1).max(512),
    givenName: text(64).min(1),
    surname: text(64).min(1),
    displayName: text(256).min(1),
    /** The RDN value; the naming check suggests it (the display name, or a fallback). */
    cn: text(64).min(1),
    samAccountName: samAccountNameSchema,
    userPrincipalName: userPrincipalNameSchema.refine((v) => !CONTROL_CHARS.test(v), {
      message: 'cannot contain control characters',
    }),
    mailFromUpn: z.boolean(),
    /** A personal address, written to `otherMailbox`. */
    personalEmail: z.string().trim().email().max(256).nullable().optional(),
    mobile: optionalText(64),
    telephoneNumber: optionalText(64),
    /**
     * Phone numbers to write as typed though they can't be read as one;
     * any other is written in Entra's form, or refused if unreadable.
     */
    keepPhonesAsTyped: z.array(z.enum(PHONE_FIELDS)).max(PHONE_FIELDS.length).optional(),
    password: userCreatePasswordSchema,
    enabled: z.boolean(),
    organisation: newUserOrganisationSchema.optional(),
    /**
     * Groups to add the account to, by objectGUID, after its password and
     * before it's enabled. Needs `write:group.membership` as well.
     */
    groups: z
      .array(z.guid())
      .max(MAX_NEW_USER_GROUPS)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
        message: 'lists a group twice',
      })
      .optional(),
    /** The user this one is a copy of, by objectGUID, recorded with the create. */
    copiedFrom: z.guid().optional(),
  })
  .strict();
export type UserCreateRequest = z.input<typeof userCreateRequestSchema>;

/** The steps a create left undone, run again on the account it made. */
export const userCreateFinishRequestSchema = z
  .object({
    /** Needed when the password is among the steps left. */
    password: userCreatePasswordSchema.optional(),
    enabled: z.boolean(),
  })
  .strict();
export type UserCreateFinishRequest = z.infer<typeof userCreateFinishRequestSchema>;

/** Why adding someone to a group grants rights: AD protects it, or it maps to an OpenADUC role. */
export type GroupPrivilege = { reason: 'protected' } | { reason: 'role'; role: Role };

export interface CopiedGroup {
  id: string;
  name: string;
  distinguishedName: string;
  /** Null for a group that grants no administrative rights. */
  privilege: GroupPrivilege | null;
}

/** What copying a user starts from: GET /api/users/:id/copy. */
export interface UserCopySource {
  source: {
    id: string;
    distinguishedName: string;
    samAccountName: string;
    displayName: string | null;
  };
  /** The source's OU, which the copy is created in; null when it isn't in an OU (CN=Users). */
  ouDn: string | null;
  organisation: Record<NewUserOrganisationField, string | null>;
  /** Null when the source has none, or it isn't a user OpenADUC knows. */
  manager: { id: string; distinguishedName: string; displayName: string | null } | null;
  /**
   * The groups the source is directly in that a copy can be added to: not
   * its primary group (AD makes Domain Users every new account's), nor a
   * group OpenADUC doesn't know.
   */
  groups: CopiedGroup[];
}

export interface UserCreateResponse {
  /** The account's objectGUID; null when it was made but couldn't be read back. */
  id: string | null;
  distinguishedName: string;
  samAccountName: string;
  completed: UserCreateStep[];
  /** What's left, in order; empty when the account is finished. */
  remaining: UserCreateStep[];
  /** Groups the create was to add the account to that no longer exist, so were left out. */
  groupsSkipped?: string[];
  /** Why the first remaining step failed, or null. */
  failure: { step: UserCreateStep; message: string } | null;
}
