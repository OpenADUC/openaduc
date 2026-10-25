// SPDX-License-Identifier: BUSL-1.1
// Phone numbers as Entra ID expects them on a synced account: "+CC NUMBER",
// the country calling code, a space, and the national number in digits
// (with "x" and the extension, if any). A number that can't be read is
// kept as typed, with a warning, so the operator decides.
import {
  getCountries,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';

export type PhoneKind = 'mobile' | 'telephone';

export interface NormalizedPhone {
  /** What to write: Entra's form, or the input trimmed when it can't be read. */
  value: string;
  /** Why the value may be wrong, or null. */
  warning: string | null;
  /** False when it couldn't be read as a number, so `value` is as typed. */
  readable: boolean;
}

/** The ISO 3166 codes a directory's default country can be. */
export function phoneCountries(): string[] {
  return getCountries();
}

export function isPhoneCountry(code: string): boolean {
  return isSupportedCountry(code);
}

export function normalizePhone(
  input: string,
  options: { kind: PhoneKind; defaultCountry?: string | null | undefined },
): NormalizedPhone {
  const typed = input.trim();
  if (!typed) return { value: '', warning: null, readable: true };
  const country =
    options.defaultCountry && isSupportedCountry(options.defaultCountry)
      ? (options.defaultCountry as CountryCode)
      : undefined;
  const parsed = parsePhoneNumberFromString(typed, country);
  if (!parsed || !parsed.isValid()) {
    const international = typed.startsWith('+') || typed.startsWith('00');
    return {
      value: typed,
      readable: false,
      warning:
        !country && !international
          ? `Add the country code (such as +44): “${typed}” has none, and this directory has no default country.`
          : `“${typed}” isn’t a phone number OpenADUC can read, so it’s kept as typed.`,
    };
  }
  const value = `+${parsed.countryCallingCode} ${parsed.nationalNumber}${parsed.ext ? `x${parsed.ext}` : ''}`;
  if (options.kind === 'mobile' && parsed.getType() === 'FIXED_LINE') {
    return { value, warning: `${value} is a landline number, not a mobile.`, readable: true };
  }
  return { value, warning: null, readable: true };
}
