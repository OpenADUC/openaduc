// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  SETTLE_WINDOW_MS,
  SYNC_WINDOW_MS,
  checkedLicenses,
  retryMs,
  settleOutcome,
  syncOutcome,
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
      { skuId: E3, skuPartNumber: 'SPE_E3' },
      { skuId: EMS, skuPartNumber: 'EMS' },
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
  const synced = new Date('2026-10-24T09:00:00Z');
  const at = (ms: number) => new Date(synced.getTime() + ms);
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
    expect(settleOutcome(settled, synced, 1, at(MINUTE))).toEqual({ status: 'settled' });
  });

  it('waits, looking less often, within the window, then gives up', () => {
    expect(settleOutcome(pending, synced, 1, at(MINUTE))).toEqual({
      status: 'waiting',
      afterMs: MINUTE,
      message:
        'Waiting for Entra to assign Microsoft 365 E3 and Enterprise Mobility + Security E3.',
    });
    expect(settleOutcome(pending, synced, 4, at(MINUTE))).toMatchObject({ afterMs: 8 * MINUTE });
    expect(settleOutcome(pending, synced, 4, at(SETTLE_WINDOW_MS - 1)).status).toBe('waiting');
    expect(settleOutcome(pending, synced, 9, at(SETTLE_WINDOW_MS))).toMatchObject({
      status: 'timed_out',
      message: expect.stringMatching(/two hours after they synced/),
    });
  });
});

describe('syncOutcome', () => {
  it('waits a day for Connect Sync, then gives up', () => {
    const started = new Date('2026-10-24T09:00:00Z');
    expect(syncOutcome(started, 2, new Date(started.getTime() + MINUTE))).toMatchObject({
      status: 'waiting',
      afterMs: 2 * MINUTE,
    });
    expect(syncOutcome(started, 30, new Date(started.getTime() + SYNC_WINDOW_MS)).status).toBe(
      'timed_out',
    );
  });
});

describe('retryMs', () => {
  it('doubles from a minute up to a quarter of an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryMs)).toEqual(
      [1, 2, 4, 8, 15, 15, 15].map((m) => m * MINUTE),
    );
  });
});
