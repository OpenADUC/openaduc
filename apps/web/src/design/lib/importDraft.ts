// SPDX-License-Identifier: BUSL-1.1
// An import's draft, kept in sessionStorage until the run: it survives a
// reload, but not closing the tab, and never reaches the server. A typed
// password is never kept in it.
import type {
  BucketPlacement,
  ImportField,
  ImportMapping,
  ParsedTable,
  PasswordMode,
} from '@openaduc/shared';

export const IMPORT_STEPS = ['source', 'columns', 'names', 'buckets', 'options', 'check'] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

/** Names the operator typed for a row in place of the naming check's. */
export interface TypedNames {
  samAccountName?: string;
  upnLocal?: string;
  displayName?: string;
}

export interface ImportOptions {
  passwordMode: PasswordMode;
  mustChange: boolean;
  enabled: boolean;
  mailFromUpn: boolean;
}

export interface ImportDraft {
  version: 1;
  step: ImportStep;
  /** The OU the import was started from, every bucket's default. */
  startOuDn: string | null;
  fileName: string | null;
  table: ParsedTable | null;
  mapping: ImportMapping;
  /** Rows the operator left out, by index. */
  excluded: number[];
  typed: Record<number, TypedNames>;
  /** Approved deviations, as `${row}\n${approvalKey}`. */
  approved: string[];
  /** The column chosen to group by; until one is, Department when it's mapped. */
  groupBy: ImportField | null;
  groupByChosen: boolean;
  /** Rows moved to another bucket: row index to bucket key. */
  moves: Record<number, string>;
  /** Buckets the operator placed, by key, for the current grouping. */
  placements: Record<string, BucketPlacement>;
  options: ImportOptions;
}

const key = (directoryId: number) => `openaduc.userImport.${directoryId}`;

export function loadDraft(directoryId: number): ImportDraft | null {
  try {
    const raw = sessionStorage.getItem(key(directoryId));
    const draft = raw ? (JSON.parse(raw) as ImportDraft) : null;
    return draft?.version === 1 ? draft : null;
  } catch {
    return null;
  }
}

export function saveDraft(directoryId: number, draft: ImportDraft): void {
  try {
    sessionStorage.setItem(key(directoryId), JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the import still works, it just won't survive a reload.
  }
}

export function clearDraft(directoryId: number): void {
  try {
    sessionStorage.removeItem(key(directoryId));
  } catch {
    // Nothing to clear.
  }
}
