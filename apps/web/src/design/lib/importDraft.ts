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

/** Issue TAPs for class, as the Options step has it. */
export interface ClassTapDraft {
  on: boolean;
  /** The class's date for everyone, as a date input gives it. */
  date: string;
  /** When class starts that day, as a time input gives it. */
  time: string;
  /** Each person's start date at `time`, when the Start date column is mapped. */
  byStartDate: boolean;
  lifetimeMinutes: number;
  isUsableOnce: boolean;
}

export interface ImportOptions {
  passwordMode: PasswordMode;
  mustChange: boolean;
  enabled: boolean;
  mailFromUpn: boolean;
  classTap?: ClassTapDraft;
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

/** Whose draft: one per operator and directory, so a shared browser keeps them apart. */
export interface DraftOwner {
  directoryId: number;
  actorId: string;
}

const PREFIX = 'openaduc.userImport.';
const key = (owner: DraftOwner) => `${PREFIX}${owner.directoryId}.${owner.actorId}`;

export function loadDraft(owner: DraftOwner): ImportDraft | null {
  try {
    const raw = sessionStorage.getItem(key(owner));
    const draft = raw ? (JSON.parse(raw) as ImportDraft) : null;
    return draft?.version === 1 ? draft : null;
  } catch {
    return null;
  }
}

/**
 * The draft as stored: only the columns it maps, so a column left out,
 * such as an HR sheet's temporary passwords, isn't kept in the browser.
 */
export function storedDraft(draft: ImportDraft): ImportDraft {
  const table = draft.table;
  if (!table) return draft;
  const kept = draft.mapping.flatMap((field, i) => (field ? [i] : []));
  return {
    ...draft,
    table: {
      ...table,
      header: kept.map((i) => table.header[i]!),
      rows: table.rows.map((row) => kept.map((i) => row[i]!)),
    },
    mapping: kept.map((i) => draft.mapping[i]!),
  };
}

export function saveDraft(owner: DraftOwner, draft: ImportDraft): void {
  try {
    sessionStorage.setItem(key(owner), JSON.stringify(storedDraft(draft)));
  } catch {
    // Storage full or blocked: the import still works, it just won't survive a reload.
  }
}

export function clearDraft(owner: DraftOwner): void {
  try {
    sessionStorage.removeItem(key(owner));
  } catch {
    // Nothing to clear.
  }
}

/** Every operator's drafts in this tab, as signing out leaves none behind. */
export function clearAllDrafts(): void {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    // Nothing to clear.
  }
}
