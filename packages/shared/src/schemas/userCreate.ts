// SPDX-License-Identifier: BUSL-1.1
// Creating a user: the directory's defaults for new accounts.
import { z } from 'zod';
import { isPhoneCountry } from '../phone.js';

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
