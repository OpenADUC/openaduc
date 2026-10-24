// SPDX-License-Identifier: BUSL-1.1
import { licenseSku } from '../../lib/skuNames.js';
import type { CheckedLicense, ExpectedLicenseGroup } from '../../db/types.js';
import { assignmentError, assignmentState } from '../entraLicenses.js';

// When an import's license check looks again and gives up, and what it
// makes of what Entra lists, kept free of I/O.

const MINUTE = 60_000;
/** Connect Sync runs every 30 minutes by default; a day covers a sync held up a while. */
export const SYNC_WINDOW_MS = 24 * 60 * MINUTE;
/** Group-based licensing usually settles in minutes, a big tenant's in an hour or two. */
export const SETTLE_WINDOW_MS = 2 * 60 * MINUTE;
const MAX_WAIT_MS = 15 * MINUTE;

/** How long to wait before looking again after `attempts` looks: doubling from a minute, up to a quarter of an hour. */
export const retryMs = (attempts: number): number =>
  Math.min(MAX_WAIT_MS, MINUTE * 2 ** Math.max(0, attempts - 1));

export const lower = (v: string) => v.toLowerCase();

/** A user's license assignment states, as Graph lists them. */
export type AssignmentStates = readonly {
  skuId: string;
  assignedByGroup?: string | null | undefined;
  state?: string | null | undefined;
  error?: string | null | undefined;
}[];

/**
 * Each license the row's groups grant, as these states say it stands:
 * pending until Entra lists it on the user from that group.
 */
export function checkedLicenses(
  expected: readonly ExpectedLicenseGroup[],
  states: AssignmentStates,
): CheckedLicense[] {
  return expected.flatMap((g) =>
    g.skus.map((sku) => {
      const found = states.find(
        (s) =>
          lower(s.skuId) === lower(sku.skuId) &&
          !!s.assignedByGroup &&
          lower(s.assignedByGroup) === lower(g.entraGroupId),
      );
      return {
        skuId: sku.skuId,
        skuPartNumber: sku.skuPartNumber,
        group: g.name,
        state: found ? assignmentState(found) : 'pending',
        error: found ? assignmentError(found.error) : null,
      };
    }),
  );
}

export type CheckOutcome =
  | { status: 'settled' }
  | { status: 'waiting'; afterMs: number; message: string }
  | { status: 'timed_out'; message: string };

const nameOf = (l: CheckedLicense) => licenseSku(l.skuId, l.skuPartNumber).name;
const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;

/**
 * Whether the check is done: every license listed (with or without an
 * error), or, past the settling window since they synced, given up on.
 */
export function settleOutcome(
  licenses: readonly CheckedLicense[],
  syncedAt: Date,
  attempts: number,
  now: Date,
): CheckOutcome {
  const pending = licenses.filter((l) => l.state === 'pending');
  if (pending.length === 0) return { status: 'settled' };
  const names = list([...new Set(pending.map(nameOf))]);
  if (now.getTime() - syncedAt.getTime() >= SETTLE_WINDOW_MS) {
    return {
      status: 'timed_out',
      message: `Entra still hadn’t assigned ${names} two hours after they synced. Their Licenses tab shows how it stands now.`,
    };
  }
  return {
    status: 'waiting',
    afterMs: retryMs(attempts),
    message: `Waiting for Entra to assign ${names}.`,
  };
}

/** Whether to keep looking for someone Connect Sync hasn't brought yet. */
export function syncOutcome(startedAt: Date, attempts: number, now: Date): CheckOutcome {
  if (now.getTime() - startedAt.getTime() >= SYNC_WINDOW_MS) {
    return {
      status: 'timed_out',
      message:
        'Not in Microsoft Entra a day after the import made the account, so their licenses weren’t checked. Their Licenses tab shows them once they sync.',
    };
  }
  return {
    status: 'waiting',
    afterMs: retryMs(attempts),
    message: 'Waiting for Connect Sync to bring them to Microsoft Entra.',
  };
}
