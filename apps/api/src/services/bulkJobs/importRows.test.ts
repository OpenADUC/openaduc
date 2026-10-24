// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { adoptable, generalizedTime, managersFirst } from './importRows.js';

const rows = (...managers: (number | null)[]) => managers.map((managerRow) => ({ managerRow }));

describe('managersFirst', () => {
  it('keeps the rows’ order when no manager comes later', () => {
    expect(managersFirst(rows(null, 0, 0, null))).toEqual([0, 1, 2, 3]);
  });

  it('moves each manager the import creates before the people they manage, chains included', () => {
    // 0 reports to 2, who reports to 3.
    expect(managersFirst(rows(2, null, 3, null))).toEqual([3, 2, 0, 1]);
  });

  it('places every row once, even round a loop the request would refuse', () => {
    expect(managersFirst(rows(1, 0)).sort()).toEqual([0, 1]);
  });
});

describe('adoptable', () => {
  const planned = { samAccountName: 'jane.doe', userPrincipalName: 'jane.doe@corp.test' };
  const account = { ...planned, enabled: false };
  const started = new Date('2026-10-25T06:12:34.567Z');

  it('takes on the disabled account with the row’s names, created since the job started', () => {
    expect(adoptable(account, '20261025061234.0Z', planned, started)).toBe(true);
    expect(
      adoptable({ ...account, samAccountName: 'JANE.DOE' }, '20261025070000.0Z', planned, started),
    ).toBe(true);
  });

  it('leaves anyone else’s: older, enabled, or with another UPN', () => {
    expect(adoptable(account, '20261025061233.0Z', planned, started)).toBe(false);
    expect(adoptable({ ...account, enabled: true }, '20261025070000.0Z', planned, started)).toBe(
      false,
    );
    expect(
      adoptable(
        { ...account, userPrincipalName: 'jane@corp.test' },
        '20261025070000.0Z',
        planned,
        started,
      ),
    ).toBe(false);
    expect(adoptable(account, null, planned, started)).toBe(false);
  });

  it('reads AD’s GeneralizedTime', () => {
    expect(generalizedTime('20261025061234.0Z')?.toISOString()).toBe('2026-10-25T06:12:34.000Z');
    expect(generalizedTime('soon')).toBeNull();
  });
});
