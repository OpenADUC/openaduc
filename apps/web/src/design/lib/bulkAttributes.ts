// SPDX-License-Identifier: BUSL-1.1
import { directoryCountry, directoryCountryCodes, type BulkAttributeField } from '@openaduc/shared';

/** Each field a bulk edit changes, as the form labels it. */
export const ATTRIBUTE_LABELS: Record<BulkAttributeField, string> = {
  title: 'Title',
  department: 'Department',
  company: 'Company',
  physicalDeliveryOfficeName: 'Office',
  manager: 'Manager',
  description: 'Description',
  streetAddress: 'Street',
  postOfficeBox: 'PO box',
  l: 'City',
  st: 'State / Province',
  postalCode: 'Postal code',
  country: 'Country',
};

/** Fields by name, in a sentence: "department, title and office", or "department and 4 more". */
export function fieldNames(fields: readonly BulkAttributeField[]): string {
  const names = fields.map((f) => ATTRIBUTE_LABELS[f].toLowerCase());
  if (names.length > 3) return `${names[0]} and ${names.length - 1} more fields`;
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Every country an edit can set, by name. */
export function countryOptions(): { value: string; label: string }[] {
  return directoryCountryCodes()
    .map((value) => ({ value, label: `${directoryCountry(value)!.co} (${value})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** A value in the preview: what it is, or that there's none. */
export const shownValue = (value: string | null): string => value ?? '(empty)';
