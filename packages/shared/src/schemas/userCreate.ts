// SPDX-License-Identifier: BUSL-1.1
// Creating a user: the directory's defaults for new accounts, the create
// request, and how far a create got.
import { z } from 'zod';
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

/** AD's order: the account is created disabled, then given a password, then enabled. */
export const USER_CREATE_STEPS = ['create', 'password', 'enable'] as const;
export type UserCreateStep = (typeof USER_CREATE_STEPS)[number];

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
    password: userCreatePasswordSchema,
    enabled: z.boolean(),
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

export interface UserCreateResponse {
  /** The account's objectGUID; null when it was made but couldn't be read back. */
  id: string | null;
  distinguishedName: string;
  samAccountName: string;
  completed: UserCreateStep[];
  /** What's left, in order; empty when the account is finished. */
  remaining: UserCreateStep[];
  /** Why the first remaining step failed, or null. */
  failure: { step: UserCreateStep; message: string } | null;
}
