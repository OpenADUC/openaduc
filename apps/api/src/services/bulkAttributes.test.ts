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

const user = (raw: Record<string, unknown> = {}, managerDn: string | null = null) =>
  cachedValues({
    title: 'Engineer',
    department: ' Sales ',
    manager_dn: managerDn,
    raw_attributes_json: raw,
  });

describe('fieldChanges', () => {
  it('leaves out a field already as asked, and one the edit doesn’t name', () => {
    expect(fieldChanges(user(), { department: 'Sales', title: 'Lead', company: null })).toEqual([
      { field: 'title', before: 'Engineer', after: 'Lead' },
    ]);
  });

  it('takes a manager’s DN in any case as the same manager', () => {
    const values = user({}, MANAGER);
    expect(fieldChanges(values, { manager: { dn: MANAGER.toUpperCase(), name: 'Erin' } })).toEqual(
      [],
    );
    expect(fieldChanges(values, { manager: null })).toEqual([
      { field: 'manager', before: MANAGER, after: null },
    ]);
  });

  it('takes country number 0 as no country', () => {
    expect(fieldChanges(user({ countryCode: '0' }), { country: null })).toEqual([]);
  });
});

describe('patchFor', () => {
  it('writes the country’s three attributes together, and 0 for none, as ADUC does', () => {
    const values = user({ c: 'GB', co: 'United Kingdom', countryCode: 826 });
    const cleared = fieldChanges(values, { country: null });

    expect(patchFor(cleared)).toEqual({ c: null, co: null, countryCode: '0' });
    expect(rowSnapshots(cleared)).toEqual({
      before: { c: 'GB', co: 'United Kingdom', countryCode: '826' },
      after: { c: null, co: null, countryCode: null },
    });
  });

  it('writes the manager by DN', () => {
    const changes = fieldChanges(user(), { manager: { dn: MANAGER, name: 'Erin' } });
    expect(patchFor(changes)).toEqual({ managerDn: MANAGER });
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
