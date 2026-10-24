// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { managersFirst } from './importRows.js';

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
