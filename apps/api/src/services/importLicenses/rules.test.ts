// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  SETTLE_WINDOW_MS,
  SYNC_WINDOW_MS,
  checkedLicenses,
  retryMs,
  settleOutcome,
  stopOf,
  type WaitingCheck,
} from './rules.js';

const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const EMS = 'efccb6f7-5641-4e0e-bd10-b4976e1bf68e';
const MINUTE = 60_000;
const expected = [
  {
    groupId: 'g1',
    entraGroupId: 'ENTRA-STAFF',
    name: 'All Staff',
    skus: [
      { skuId: E3, skuPartNumber: 'SPE_E3', disabledPlanCount: 0 },
      { skuId: EMS, skuPartNumber: 'EMS', disabledPlanCount: 0 },
    ],
  },
];

describe('checkedLicenses', () => {
  it('reads each license from its group, pending until Entra lists it from there', () => {
    const licenses = checkedLicenses(expected, [
      {
        skuId: E3.toUpperCase(),
        assignedByGroup: 'entra-staff',
        state: 'Error',
        error: 'CountViolation',
      },
      // The same product assigned directly isn't the group's.
      { skuId: EMS, assignedByGroup: null, state: 'Active', error: 'None' },
    ]);
    expect(licenses).toEqual([
      {
        skuId: E3,
        skuPartNumber: 'SPE_E3',
        group: 'All Staff',
        state: 'error',
        error: 'CountViolation',
      },
      { skuId: EMS, skuPartNumber: 'EMS', group: 'All Staff', state: 'pending', error: null },
    ]);
  });

  it('names an error Graph adds later Other', () => {
    expect(
      checkedLicenses(expected.slice(0, 1), [
        { skuId: E3, assignedByGroup: 'ENTRA-STAFF', state: 'ActiveWithError', error: 'NewKind' },
      ])[0],
    ).toMatchObject({ state: 'activeWithError', error: 'Other' });
  });
});

describe('settleOutcome', () => {
  const settled = checkedLicenses(expected, [
    { skuId: E3, assignedByGroup: 'entra-staff', state: 'Active' },
    {
      skuId: EMS,
      assignedByGroup: 'entra-staff',
      state: 'Error',
      error: 'MutuallyExclusiveViolation',
    },
  ]);
  const pending = checkedLicenses(expected, []);

  it('settles once every license is listed, error or not', () => {
    expect(settleOutcome(settled, 1)).toEqual({ status: 'settled' });
  });

  it('waits, looking less often', () => {
    expect(settleOutcome(pending, 1)).toEqual({
      status: 'waiting',
      afterMs: MINUTE,
      message:
        'Waiting for Entra to assign Microsoft 365 E3 and Enterprise Mobility + Security E3.',
    });
    expect(settleOutcome(pending, 4)).toMatchObject({ afterMs: 8 * MINUTE });
  });
});

describe('stopOf', () => {
  const created = new Date('2026-10-24T09:00:00Z');
  const at = (ms: number) => new Date(created.getTime() + ms);
  const unsynced: WaitingCheck = {
    code: 'unsynced',
    message: 'Waiting for Connect Sync to bring them to Microsoft Entra.',
    startedAt: created,
    syncedAt: null,
    licenses: null,
    hasAccount: true,
    licensesOn: true,
  };

  it('waits for sync a day from the account’s creation, then times out', () => {
    expect(stopOf(unsynced, at(SYNC_WINDOW_MS - 1))).toBeNull();
    expect(stopOf(unsynced, at(SYNC_WINDOW_MS))).toMatchObject({
      code: 'sync_timeout',
      message: expect.stringMatching(/^Timed out waiting for sync/),
    });
  });

  it('waits two hours from sync for licensing to settle, then times out naming what’s missing', () => {
    const synced = {
      ...unsynced,
      code: null,
      syncedAt: at(SYNC_WINDOW_MS),
      licenses: checkedLicenses(expected, [
        { skuId: E3, assignedByGroup: 'entra-staff', state: 'Active' },
      ]),
    };
    expect(stopOf(synced, at(SYNC_WINDOW_MS + SETTLE_WINDOW_MS - 1))).toBeNull();
    expect(stopOf(synced, at(SYNC_WINDOW_MS + SETTLE_WINDOW_MS))).toEqual({
      code: 'settle_timeout',
      message:
        'Timed out waiting for Entra to assign Enterprise Mobility + Security E3 two hours after they synced. Their Licenses tab shows how it stands now.',
    });
  });

  it('stops past the deadline with the last error it met, if any', () => {
    const refused = {
      ...unsynced,
      code: 'graph_refused' as const,
      message: 'Microsoft Graph refused: Insufficient privileges.',
    };
    expect(stopOf(refused, at(SYNC_WINDOW_MS))).toEqual({
      code: 'graph_refused',
      message: 'Microsoft Graph refused: Insufficient privileges.',
    });
    expect(stopOf({ ...unsynced, hasAccount: false }, at(SYNC_WINDOW_MS))).toMatchObject({
      code: 'not_created',
    });
  });

  it('stops at once when licenses are turned off', () => {
    expect(stopOf({ ...unsynced, licensesOn: false }, created)).toEqual({
      code: 'licenses_off',
      message: 'Licenses were turned off for this directory, so their licenses weren’t checked.',
    });
  });
});

describe('retryMs', () => {
  it('doubles from a minute up to a quarter of an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryMs)).toEqual(
      [1, 2, 4, 8, 15, 15, 15].map((m) => m * MINUTE),
    );
  });
});
