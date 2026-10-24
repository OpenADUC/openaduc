// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { SkuSeats } from '../entraLicenses.js';
import { nestedWarnings, seatWarnings, wantedSeats, type LicensedGroup } from './check.js';

const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const E5 = '06ebc4ee-1bb5-47dd-8120-11324bc54e06';
const EMS = 'efccb6f7-5641-4e0e-bd10-b4976e1bf68e';
const CUSTOM = '00000000-0000-0000-0000-00000000c0de';
const sku = (skuId: string) => ({ skuId, skuPartNumber: null, disabledPlanCount: 0 });
const group = (id: string, name: string, skuIds: string[]): LicensedGroup => ({
  id,
  name,
  entraGroupId: `entra-${id}`,
  skus: skuIds.map(sku),
});
const seats = (skuId: string, enabled: number, warning: number, consumed: number): SkuSeats => ({
  skuId,
  skuPartNumber: null,
  enabled,
  warning,
  consumed,
});

describe('seatWarnings', () => {
  it('counts grace-period units as free, never goes below none, and names a missing subscription', () => {
    const licensed = new Map([
      ['staff', group('staff', 'All Staff', [E3, E5])],
      ['sales', group('sales', 'Sales', [EMS, CUSTOM, E3])],
    ]);
    // Three people in All Staff, two of them in Sales as well.
    const wanted = wantedSeats(
      [{ groups: ['STAFF', 'sales'] }, { groups: ['staff', 'sales'] }, { groups: ['staff'] }],
      licensed,
    );
    expect([...wanted].map(([k, w]) => [k, w.people])).toEqual([
      [E3, 3],
      [E5, 3],
      [EMS, 2],
      [CUSTOM, 2],
    ]);
    const tenant = new Map([
      // 1 active + 2 in grace = 3 free: enough.
      [E3, seats(E3, 10, 2, 9)],
      // 2 free, both in grace.
      [E5, seats(E5, 5, 2, 5)],
      // Suspended: nothing enabled, and more consumed than there is.
      [EMS, seats(EMS, 0, 0, 4)],
    ]);
    expect(seatWarnings(wanted, tenant).map((w) => w.message)).toEqual([
      'Microsoft 365 E5: 3 people join groups that grant it, but only 2 are free, 2 of them in a subscription’s grace period that will lapse. Entra won’t assign it to 1 of them until licenses are bought or freed up.',
      'Enterprise Mobility + Security E3: 2 people join groups that grant it, but none is free. Entra won’t assign it to 2 of them until licenses are bought or freed up.',
      `${CUSTOM}: 2 people join groups that grant it, but the tenant has no subscription to it. Entra won’t assign it to 2 of them until licenses are bought or freed up.`,
    ]);
  });
});

describe('nestedWarnings', () => {
  const licensed = new Map([['staff', group('staff', 'All Staff', [E3])]]);
  const ancestors = new Map([['eng', [{ name: 'All Staff', skus: [sku(E3), sku(EMS)] }]]]);
  const name = (id: string) => ({ eng: 'Engineering', staff: 'All Staff' })[id] ?? id;

  it('counts only the people whose own groups don’t grant the product', () => {
    const warnings = nestedWarnings(
      [{ groups: ['eng'] }, { groups: ['ENG', 'staff'] }, { groups: ['eng'] }],
      licensed,
      ancestors,
      name,
    );
    expect(warnings).toEqual([
      {
        row: null,
        kind: 'license_nested',
        message:
          '2 people would only get Microsoft 365 E3 through nesting: “Engineering” is inside “All Staff”, but group-based licensing doesn’t follow nested groups. License “Engineering” directly, or add them to “All Staff” too.',
      },
      expect.objectContaining({
        message: expect.stringMatching(
          /^3 people would only get Enterprise Mobility \+ Security E3 through nesting/,
        ),
      }),
    ]);
  });

  it('says nothing when every one of them gets it directly', () => {
    expect(
      nestedWarnings(
        [{ groups: ['eng', 'staff'] }],
        licensed,
        new Map([['eng', [{ name: 'All Staff', skus: [sku(E3)] }]]]),
        name,
      ),
    ).toEqual([]);
  });
});
