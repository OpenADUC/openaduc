// SPDX-License-Identifier: BUSL-1.1
import { phoneCountries, type PasswordMode } from '@openaduc/shared';

export const PASSWORD_MODE_LABEL: Record<PasswordMode, string> = {
  random: 'Random, never shown',
  generate: 'Generated, shown once',
  set: 'Typed in',
};

/** Every country a phone number can be read in, by name. */
export function phoneCountryOptions(): { value: string; label: string }[] {
  const names = new Intl.DisplayNames(undefined, { type: 'region' });
  return phoneCountries()
    .map((value) => ({ value, label: `${names.of(value) ?? value} (${value})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
