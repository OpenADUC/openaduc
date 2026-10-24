// SPDX-License-Identifier: BUSL-1.1
import {
  phoneCountries,
  type GroupPrivilege,
  type NewUserOrganisationField,
  type PasswordMode,
  type Role,
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

/** The organisation fields a copy prefills that the operator types in; the country is one unit. */
export const ORGANISATION_INPUTS: {
  field: NewUserOrganisationField;
  label: string;
  max: number;
}[] = [
  { field: 'title', label: 'Title', max: 128 },
  { field: 'department', label: 'Department', max: 64 },
  { field: 'company', label: 'Company', max: 64 },
  { field: 'physicalDeliveryOfficeName', label: 'Office', max: 128 },
  { field: 'streetAddress', label: 'Street', max: 1024 },
  { field: 'l', label: 'City', max: 128 },
  { field: 'st', label: 'State / Province', max: 128 },
  { field: 'postalCode', label: 'Postal code', max: 40 },
];

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
