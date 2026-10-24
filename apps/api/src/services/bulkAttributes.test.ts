// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  attributesPreviewToken,
  cachedValues,
  fieldChanges,
  patchFor,
  rowSnapshots,
} from './bulkAttributes.js';

const MANAGER = 'CN=Erin Evans,OU=Staff,DC=example,DC=test';
const NO_COUNTRY = { c: null, co: null, countryCode: null };
const GB = { c: 'GB', co: 'United Kingdom', countryCode: '826' };

const user = (
  raw: Record<string, unknown> = {},
  more: { manager_dn?: string; office?: string | null; office_read?: boolean } = {},
) =>
  cachedValues({
    title: 'Engineer',
    department: ' Sales ',
    manager_dn: more.manager_dn ?? null,
    office: more.office ?? null,
    office_read: more.office_read ?? true,
    raw_attributes_json: raw,
  });

describe('fieldChanges', () => {
  it('leaves out a field already as asked, and one the edit doesn’t name', () => {
    expect(fieldChanges(user(), { department: 'Sales', title: 'Lead', company: null })).toEqual({
      changes: [{ field: 'title', before: 'Engineer', after: 'Lead' }],
      unread: [],
    });
  });

  it('takes a manager’s DN in any case as the same manager', () => {
    const values = user({}, { manager_dn: MANAGER });
    expect(fieldChanges(values, { manager: MANAGER.toUpperCase() }).changes).toEqual([]);
    expect(fieldChanges(values, { manager: null }).changes).toEqual([
      { field: 'manager', before: MANAGER, after: null },
    ]);
  });

  it('compares a country by code and number, never by its name', () => {
    const spelt = user({ c: 'GB', co: 'Great Britain', countryCode: '826' });
    expect(fieldChanges(spelt, { country: GB }).changes).toEqual([]);
    expect(fieldChanges(user({ countryCode: '0' }), { country: NO_COUNTRY }).changes).toEqual([]);
    expect(fieldChanges(user({ c: 'GB' }), { country: NO_COUNTRY }).changes).toHaveLength(1);
  });

  it('compares every PO box, in any order', () => {
    const values = user({ postOfficeBox: ['PO 2', 'PO 1'] });
    expect(fieldChanges(values, { postOfficeBox: ['PO 1', 'PO 2'] }).changes).toEqual([]);
    expect(fieldChanges(values, { postOfficeBox: ['PO 1'] }).changes).toHaveLength(1);
  });

  it('says when the office isn’t known, rather than taking it as empty', () => {
    const unread = user({}, { office_read: false });
    expect(fieldChanges(unread, { physicalDeliveryOfficeName: 'Leeds' })).toEqual({
      changes: [],
      unread: ['physicalDeliveryOfficeName'],
    });
  });
});

describe('patchFor', () => {
  it('writes the country’s three attributes together, and number 0 for none', () => {
    const { changes } = fieldChanges(user({ c: 'GB', co: 'United Kingdom', countryCode: 826 }), {
      country: NO_COUNTRY,
    });

    expect(patchFor(changes)).toEqual({ c: null, co: null, countryCode: '0' });
    expect(rowSnapshots(changes)).toEqual({
      before: GB,
      after: { c: null, co: null, countryCode: '0' },
    });
  });

  it('writes the manager by DN, and replaces every PO box', () => {
    const { changes } = fieldChanges(user({ postOfficeBox: ['PO 9'] }), {
      manager: MANAGER,
      postOfficeBox: ['PO 1', 'PO 2'],
    });
    expect(patchFor(changes)).toEqual({ managerDn: MANAGER, postOfficeBox: ['PO 1', 'PO 2'] });
  });
});

describe('attributesPreviewToken', () => {
  it('names the users whatever their order or case, and the changes exactly', () => {
    const a = 'AAAAAAAA-0000-4000-8000-000000000000';
    const b = 'bbbbbbbb-0000-4000-8000-000000000000';
    const token = attributesPreviewToken([a, b], { department: 'Sales' });

    expect(attributesPreviewToken([b, a.toLowerCase()], { department: 'Sales' })).toBe(token);
    expect(attributesPreviewToken([a, b], { department: 'Sales', company: null })).not.toBe(token);
    expect(attributesPreviewToken([a, b], { department: 'sales' })).not.toBe(token);
  });
});
