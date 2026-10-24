// SPDX-License-Identifier: BUSL-1.1
import {
  NEW_USER_ORGANISATION_FIELDS,
  phoneCountries,
  type GroupPrivilege,
  type NewUserOrganisationField,
  type PasswordMode,
  type Role,
  type UserCopySource,
} from '@openaduc/shared';

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

const ORGANISATION_LABEL: Record<NewUserOrganisationField, string> = {
  title: 'Title',
  department: 'Department',
  company: 'Company',
  physicalDeliveryOfficeName: 'Office',
  streetAddress: 'Street',
  l: 'City',
  st: 'State / Province',
  postalCode: 'Postal code',
  c: 'Country code',
  co: 'Country',
};

/** What a copy carries over from its source, as label and value, in ADUC's order. */
export function copiedDetails(copy: UserCopySource): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const field of NEW_USER_ORGANISATION_FIELDS) {
    const value = copy.organisation[field]?.trim();
    if (value) rows.push({ label: ORGANISATION_LABEL[field], value });
    if (field === 'company' && copy.manager) {
      rows.push({
        label: 'Manager',
        value: copy.manager.displayName ?? copy.manager.distinguishedName,
      });
    }
  }
  return rows;
}

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  operator: 'Operator',
  auditor: 'Auditor',
};

/** Why adding the copy to a group deserves a second thought. */
export function privilegeWarning(privilege: GroupPrivilege): string {
  return privilege.reason === 'protected'
    ? 'Administrative group: its members get admin rights in AD. Tick it only if this person needs them.'
    : `Gives its members OpenADUC’s ${ROLE_LABEL[privilege.role]} role. Tick it only if this person needs it.`;
}
