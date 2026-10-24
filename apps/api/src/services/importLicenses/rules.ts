// SPDX-License-Identifier: BUSL-1.1
import { andList } from '@openaduc/shared';
import { licenseSku } from '../../lib/skuNames.js';
import type {
  CheckedLicense,
  ExpectedLicenseGroup,
  ImportLicenseCheckCode,
} from '../../db/types.js';
import { assignmentError, assignmentState } from '../entraLicenses.js';

// When an import's license check looks again and when it stops, and what
// it makes of what Entra lists, kept free of I/O.

const MINUTE = 60_000;
/** Connect Sync runs every 30 minutes by default; a day covers a sync held up a while. */
export const SYNC_WINDOW_MS = 24 * 60 * MINUTE;
/** Group-based licensing usually settles in minutes, a big tenant's in an hour or two. */
export const SETTLE_WINDOW_MS = 2 * 60 * MINUTE;
const MAX_WAIT_MS = 15 * MINUTE;

export const SYNC_WAIT_MESSAGE = 'Waiting for Connect Sync to bring them to Microsoft Entra.';

export const lower = (v: string) => v.toLowerCase();

/** How long to wait before looking again after `attempts` looks: doubling from a minute, up to a quarter of an hour. */
export const retryMs = (attempts: number): number =>
  Math.min(MAX_WAIT_MS, MINUTE * 2 ** Math.max(0, attempts - 1));

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

const pendingNames = (licenses: readonly CheckedLicense[]) =>
  andList([
    ...new Set(
      licenses
        .filter((l) => l.state === 'pending')
        .map((l) => licenseSku(l.skuId, l.skuPartNumber).name),
    ),
  ]);

/** Settled once every license is listed, with or without an error; else look again later. */
export function settleOutcome(
  licenses: readonly CheckedLicense[],
  attempts: number,
): { status: 'settled' } | { status: 'waiting'; afterMs: number; message: string } {
  if (licenses.every((l) => l.state !== 'pending')) return { status: 'settled' };
  return {
    status: 'waiting',
    afterMs: retryMs(attempts),
    message: `Waiting for Entra to assign ${pendingNames(licenses)}.`,
  };
}

/** The last error a check met: past its deadline, it's why the check stopped. Throttling isn't: it passes. */
const ERROR_CODES = new Set<ImportLicenseCheckCode>([
  'graph_refused',
  'graph_unavailable',
  'directory_unavailable',
  'internal_error',
]);

export interface WaitingCheck {
  code: ImportLicenseCheckCode | null;
  message: string | null;
  /** When the account was created (else when the job was). */
  startedAt: Date;
  syncedAt: Date | null;
  licenses: readonly CheckedLicense[] | null;
  hasAccount: boolean;
  licensesOn: boolean;
}

/**
 * Why a waiting check stops now, whatever Graph would answer: the feature
 * turned off, or its deadline passed (a day from the account's creation
 * for sync, two hours from sync for licensing to settle), named by the
 * last error it met if any. Null while it may still wait.
 */
export function stopOf(
  c: WaitingCheck,
  now: Date,
): { code: ImportLicenseCheckCode; message: string } | null {
  if (!c.licensesOn) {
    return {
      code: 'licenses_off',
      message: 'Licenses were turned off for this directory, so their licenses weren’t checked.',
    };
  }
  const deadline = c.syncedAt
    ? c.syncedAt.getTime() + SETTLE_WINDOW_MS
    : c.startedAt.getTime() + SYNC_WINDOW_MS;
  if (now.getTime() < deadline) return null;
  if (!c.hasAccount) {
    return {
      code: 'not_created',
      message: 'The import didn’t create the account, so there were no licenses to check.',
    };
  }
  if (c.code && ERROR_CODES.has(c.code) && c.message) return { code: c.code, message: c.message };
  if (!c.syncedAt) {
    return {
      code: 'sync_timeout',
      message:
        'Timed out waiting for sync: they weren’t in Microsoft Entra a day after the import created the account. Their Licenses tab shows their licenses once they sync.',
    };
  }
  return {
    code: 'settle_timeout',
    message: `Timed out waiting for Entra to assign ${pendingNames(c.licenses ?? [])} two hours after they synced. Their Licenses tab shows how it stands now.`,
  };
}
