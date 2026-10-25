// SPDX-License-Identifier: BUSL-1.1
// Import users from a spreadsheet, from the user list or from an OU (which
// every bucket then starts in). Six steps: the source, which column is
// which, the names, the buckets rows are placed in, the options, and the
// final check right before the run. The options can have the run issue
// each person a Temporary Access Pass for their onboarding class, made
// once they're in Entra and listed on the import's class roster.
//
// The draft lives in sessionStorage (importDraft.ts). Before the final
// check the server is only read from: the naming check and the lookup of
// who's already in the directory, both of which need it. What a row would
// create, what needs approving and what blocks is reviewImportRow's call,
// so the review and the final check decide alike. Running the import
// checks it once more on the server and starts a job, whose results page
// (useImportJob) the wizard hands over to; the draft is done with then.

import { computed, reactive, ref, shallowRef, watch } from 'vue';
import {
  CLASS_TAP_DEFAULT_LIFETIME_MINUTES,
  DEFAULT_NEW_USER_SETTINGS,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABEL,
  IMPORT_MAX_ROWS,
  RANDOM_MODE_MUST_CHANGE_NOTE,
  approvalKey,
  bucketKey,
  bucketsOf,
  checkPassword,
  classTapDefaults,
  classTapProblems,
  startsLikeFormula,
  guessMapping,
  importRowRequest,
  importTemplateCsv,
  importValues,
  lookupsOf,
  mappingProblems,
  namingRequestOf,
  parseTable,
  resolveManagers,
  addressConflicts,
  reviewImportRow,
  ruleFor,
  startingPlacement,
  type PlannedAccount,
  type BucketPlacement,
  type ClassTapOptions,
  type ClassTapRequest,
  type DirectoryPolicy,
  type GroupSummary,
  type ImportCheckIssue,
  type ImportCheckResponse,
  type ImportField,
  type ImportPassword,
  type ImportPerson,
  type ImportRequest,
  type ImportRow,
  type ImportRowReview,
  type ImportUsageLocation,
  type ManagerMatch,
  type NamingDeviation,
  type NamingSettings,
  type NamingSuggestion,
  type NewUserSettings,
  type PasswordCheck,
  type PasswordMode,
  type PlacementRule,
} from '@openaduc/shared';
import { ApiError } from '../../api/client.js';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';
import { decodeCsv, isWorkbook } from '../lib/csvFile.js';
import {
  IMPORT_STEPS,
  clearDraft,
  loadDraft,
  saveDraft,
  type DraftOwner,
  type ImportDraft,
  type ClassTapDraft,
  type ImportStep,
  type TypedNames,
} from '../lib/importDraft.js';
import { latestRequest } from '../lib/latestRequest.js';
import { fromLocalInputs } from '../lib/localDateTime.js';
import { GROUP_PAGE_SIZE, MIN_GROUP_QUERY } from './useAddToGroup.js';
import { lifetimeOptionsFor } from './useIssueTap.js';
import { useDebouncedSearch } from './useDebouncedSearch.js';

const CHECK_DELAY_MS = 300;
const PREVIEW_ROWS = 5;

export const IMPORT_STEP_LABEL: Record<ImportStep, string> = {
  source: 'Source',
  columns: 'Map columns',
  names: 'Review names',
  buckets: 'Buckets',
  options: 'Options',
  check: 'Final check',
};

export const IMPORT_TEMPLATE_FILE = 'openaduc-user-import.csv';

function blankDraft(startOuDn: string | null, settings: NewUserSettings): ImportDraft {
  return {
    version: 1,
    step: 'source',
    startOuDn,
    fileName: null,
    table: null,
    mapping: [],
    excluded: [],
    typed: {},
    approved: [],
    groupBy: null,
    groupByChosen: false,
    moves: {},
    placements: {},
    options: {
      passwordMode: settings.passwordMode,
      mustChange: true,
      enabled: true,
      mailFromUpn: settings.mailFromUpn,
    },
  };
}

/** A row as reviewed: what blocks it, its names, and its manager. */
export interface ReviewedRow {
  review: ImportRowReview;
  suggestion: NamingSuggestion | null;
  manager: ManagerMatch;
}

/** A deviation in the review's lists, with the row it's on. */
export interface RowDeviation {
  row: number;
  line: number;
  name: string;
  deviation: NamingDeviation;
}

/**
 * A check of the directory run after a pause, keeping only the latest
 * one's answer. `prepare` says what to ask, or null to ask nothing.
 */
function delayedCheck<T>(
  prepare: () => (() => Promise<T>) | null,
  settle: (answer: T) => void,
  fail: (err: unknown) => void,
): () => void {
  const guard = latestRequest();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    const isCurrent = guard.begin();
    const ask = prepare();
    if (!ask) return;
    timer = setTimeout(async () => {
      try {
        const answer = await ask();
        if (isCurrent()) settle(answer);
      } catch (err) {
        if (isCurrent()) fail(err);
      }
    }, CHECK_DELAY_MS);
  };
}

export function useUserImport() {
  const auth = useAuthStore();
  const draft = reactive<ImportDraft>(blankDraft(null, DEFAULT_NEW_USER_SETTINGS));
  const directoryId = ref<number | null>(null);
  const owner = ref<DraftOwner | null>(null);
  const naming = ref<NamingSettings | null>(null);
  const settings = ref<NewUserSettings>({ ...DEFAULT_NEW_USER_SETTINGS });
  const policy = ref<DirectoryPolicy | null>(null);
  const rules = shallowRef<PlacementRule[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  /** The shared password in `set` mode; kept out of the draft. */
  const password = ref('');

  /**
   * Load the directory's settings and resume the draft. Started from an
   * OU, that OU becomes the start OU: buckets the operator hasn't placed
   * follow it, a resumed draft's included.
   */
  async function start(startOuDn: string | null = null): Promise<void> {
    const id = auth.actor?.directoryId ?? null;
    directoryId.value = id;
    owner.value = id && auth.actor ? { directoryId: id, actorId: auth.actor.actorId } : null;
    loadError.value = null;
    if (!id || !owner.value) return;
    loading.value = true;
    try {
      const [n, u, p, r] = await Promise.all([
        api.directories.naming.get(id),
        api.directories.newUsers.get(id),
        api.directories.policy(id).then(
          (res) => res.policy,
          () => null,
        ),
        api.directories.placementRules.get(id),
      ]);
      naming.value = n.naming;
      settings.value = u.newUsers;
      policy.value = p;
      rules.value = r.rules;
    } catch (err) {
      loadError.value = errorMessage(err, 'Couldn’t load the directory’s settings for new users');
    } finally {
      loading.value = false;
    }
    const saved = loadDraft(owner.value);
    Object.assign(draft, saved ?? blankDraft(startOuDn, settings.value));
    if (startOuDn) draft.startOuDn = startOuDn;
    await Promise.all([loadClassTapOptions(), loadUsageLocation()]);
  }

  watch(
    draft,
    () => {
      if (owner.value) saveDraft(owner.value, draft);
    },
    { deep: true },
  );

  /** Forget the draft and start again from the source. */
  function startOver(): void {
    if (owner.value) clearDraft(owner.value);
    Object.assign(draft, blankDraft(draft.startOuDn, settings.value));
    password.value = '';
    forgetCheck();
  }

  // ---- Source --------------------------------------------------------------

  const sourceError = ref<string | null>(null);
  const table = computed(() => draft.table);

  function useTable(text: string, fileName: string | null): void {
    const parsed = parseTable(text);
    Object.assign(draft, blankDraft(draft.startOuDn, settings.value), {
      table: parsed,
      fileName,
      mapping: guessMapping(parsed.header),
      options: draft.options,
    });
    forgetCheck();
  }

  function paste(text: string): void {
    sourceError.value = null;
    if (text.trim()) useTable(text, null);
  }

  /** A CSV file dropped or picked. Excel workbooks are refused: save them as CSV. */
  async function readFile(file: File): Promise<void> {
    sourceError.value = null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isWorkbook(bytes) || /\.(xlsx|xlsm|xls|ods|numbers)$/i.test(file.name)) {
      sourceError.value = `${file.name} is a workbook. Save it as CSV first, or copy the rows from Excel and paste them.`;
      return;
    }
    useTable(decodeCsv(bytes), file.name);
  }

  const sourceProblems = computed(() => {
    const t = table.value;
    if (!t) return [];
    const problems = [...t.problems];
    if (t.header.length === 0) problems.push('There’s nothing to import.');
    else if (t.rows.length === 0) {
      problems.push('There’s a header row but no rows under it.');
    }
    if (t.rows.length > IMPORT_MAX_ROWS) {
      problems.push(
        `Import up to ${IMPORT_MAX_ROWS} rows at a time; this has ${t.rows.length}. Split it.`,
      );
    }
    return problems;
  });
  /** No header the template's names would map: probably a sheet without its header row. */
  const headerMissing = computed(
    () => !!table.value?.rows.length && guessMapping(table.value.header).every((f) => f === null),
  );

  // ---- Columns -------------------------------------------------------------

  /** A field takes one column: choosing it for another moves it there. */
  function setMapping(column: number, field: ImportField | null): void {
    draft.mapping = draft.mapping.map((f, i) =>
      i === column ? field : field !== null && f === field ? null : f,
    );
    draft.typed = {};
    draft.approved = [];
  }

  const fieldOptions = [
    { value: null, label: 'Leave out' },
    ...IMPORT_FIELDS.map((f) => ({ value: f, label: IMPORT_FIELD_LABEL[f] })),
  ];
  const columnProblems = computed(() => mappingProblems(draft.mapping));

  /** Whether the directory's schema takes a mapped usage location; null until known. */
  const usageLocation = shallowRef<ImportUsageLocation | null>(null);
  async function loadUsageLocation(): Promise<void> {
    usageLocation.value = await api.users.import.usageLocation().catch(() => null);
  }
  /** Said on the Map columns step when a mapped usage location can't reach Entra. */
  const usageLocationNote = computed(() =>
    draft.mapping.includes('usageLocation') && usageLocation.value?.writable === false
      ? `Usage location won’t reach Entra: this directory’s schema has no ${usageLocation.value.attribute}, the attribute Connect Sync carries it from (Exchange’s schema extension adds it). Entra gives the new accounts the tenant’s location instead; change it there for anyone whose licenses need another.`
      : null,
  );
  const preview = computed(() => table.value?.rows.slice(0, PREVIEW_ROWS) ?? []);

  // ---- Rows ----------------------------------------------------------------

  const values = computed(() =>
    (table.value?.rows ?? []).map((r) => importValues(r, draft.mapping)),
  );
  const lineOf = (row: number) => table.value?.rowNumbers[row] ?? row + 2;
  const excluded = computed(() => new Set(draft.excluded));
  const included = computed(() =>
    values.value.map((_, i) => i).filter((i) => !excluded.value.has(i)),
  );
  const nameOf = (row: number) => {
    const v = values.value[row];
    return (
      suggestions.value.get(row)?.displayName ??
      ([v?.first, v?.last].filter(Boolean).join(' ') || `Row ${lineOf(row)}`)
    );
  };

  /** A row as the operator knows it: its spreadsheet row and the person's name. */
  const rowRef = (row: number) => ({ row, line: lineOf(row), name: nameOf(row) });

  /** Leave any row out of the import, whatever its state. */
  function exclude(row: number): void {
    if (!excluded.value.has(row)) draft.excluded = [...draft.excluded, row];
  }
  function include(row: number): void {
    draft.excluded = draft.excluded.filter((r) => r !== row);
  }

  // ---- Buckets -------------------------------------------------------------

  const groupBy = computed<ImportField | null>(() => {
    if (draft.groupByChosen) {
      return draft.groupBy && draft.mapping.includes(draft.groupBy) ? draft.groupBy : null;
    }
    return draft.mapping.includes('department') ? 'department' : null;
  });
  const groupByOptions = computed(() => [
    { value: null, label: 'Don’t group' },
    ...IMPORT_FIELDS.filter((f) => draft.mapping.includes(f)).map((f) => ({
      value: f,
      label: IMPORT_FIELD_LABEL[f],
    })),
  ]);

  function setGroupBy(field: ImportField | null): void {
    draft.groupBy = field;
    draft.groupByChosen = true;
    draft.moves = {};
    draft.placements = {};
  }

  const allBuckets = computed(() =>
    bucketsOf(values.value, included.value, groupBy.value, draft.moves),
  );
  const placementOf = (key: string): BucketPlacement =>
    draft.placements[key] ??
    startingPlacement(ruleFor(rules.value, groupBy.value, { key }), draft.startOuDn);
  const bucketOfRow = computed(() => {
    const map = new Map<number, string>();
    for (const b of allBuckets.value) for (const r of b.rows) map.set(r, b.key);
    return map;
  });
  const ouOfRow = (row: number) => {
    const key = bucketOfRow.value.get(row);
    return key === undefined ? null : placementOf(key).ouDn;
  };

  function place(key: string, change: Partial<BucketPlacement>): void {
    draft.placements = { ...draft.placements, [key]: { ...placementOf(key), ...change } };
  }
  function setBucketOu(key: string, ouDn: string | null): void {
    place(key, { ouDn });
  }
  function addBucketGroup(key: string, group: GroupSummary): void {
    const groups = placementOf(key).groups;
    if (groups.some((g) => g.id === group.id)) return;
    place(key, {
      groups: [...groups, { id: group.id, name: group.name ?? group.distinguishedName }],
    });
  }
  function removeBucketGroup(key: string, id: string): void {
    place(key, { groups: placementOf(key).groups.filter((g) => g.id !== id) });
  }
  /** Use the bucket's placement rule, as it was saved. */
  function useRule(key: string): void {
    const rule = ruleFor(rules.value, groupBy.value, { key });
    if (rule) place(key, startingPlacement(rule, null));
  }
  function moveRow(row: number, key: string): void {
    const natural = groupBy.value ? bucketKey(values.value[row]![groupBy.value]) : key;
    const moves = { ...draft.moves };
    if (key === natural) delete moves[row];
    else moves[row] = key;
    draft.moves = moves;
  }

  const canAddGroups = computed(() => auth.hasCapability('write:group.membership'));
  const groupSearch = useDebouncedSearch<GroupSummary>({
    minLength: MIN_GROUP_QUERY,
    delayMs: 200,
    search: (q) => api.groups.search({ q, pageSize: GROUP_PAGE_SIZE }),
  });

  // ---- Names ---------------------------------------------------------------

  const reviewing = computed(
    () => IMPORT_STEPS.indexOf(draft.step) >= IMPORT_STEPS.indexOf('names'),
  );

  const typedOverrides = (row: number) => {
    const t: TypedNames = draft.typed[row] ?? {};
    return {
      samAccountName: t.samAccountName ?? null,
      userPrincipalName:
        t.upnLocal !== undefined ? `${t.upnLocal}@${naming.value?.upnSuffix ?? ''}` : null,
      displayName: t.displayName ?? null,
    };
  };
  const namingRequests = computed(() =>
    included.value.flatMap((row) => {
      const request = namingRequestOf(values.value[row]!, ouOfRow(row), typedOverrides(row));
      return request ? [{ row, request }] : [];
    }),
  );
  const namesKey = computed(() => JSON.stringify(namingRequests.value.map((r) => r.request)));
  const lookups = computed(() => lookupsOf(included.value.map((i) => values.value[i]!)));
  const lookupsKey = computed(() => JSON.stringify(lookups.value));

  const suggestions = shallowRef(new Map<number, NamingSuggestion>());
  const checkedNamesKey = ref<string | null>(null);
  const people = shallowRef<ImportPerson[] | null>(null);
  const checkedLookupsKey = ref<string | null>(null);
  const reviewError = ref<string | null>(null);

  const checkNames = delayedCheck(
    () => {
      const id = directoryId.value;
      if (!reviewing.value || !id) return null;
      const key = namesKey.value;
      const requests = namingRequests.value;
      return async () => ({
        key,
        requests,
        answers:
          requests.length === 0
            ? []
            : (
                await api.directories.naming.check(id, {
                  names: requests.map(({ request }) => ({
                    ...request.name,
                    ...(request.ouDn ? { ouDn: request.ouDn } : {}),
                    overrides: request.overrides,
                  })),
                })
              ).suggestions,
      });
    },
    ({ key, requests, answers }) => {
      suggestions.value = new Map(requests.map(({ row }, i) => [row, answers[i]!]));
      checkedNamesKey.value = key;
      reviewError.value = null;
    },
    (err) => (reviewError.value = errorMessage(err, 'Couldn’t check the names')),
  );

  const lookUp = delayedCheck(
    () => {
      if (!reviewing.value) return null;
      const key = lookupsKey.value;
      const body = lookups.value;
      return async () => ({ key, found: (await api.users.import.lookup(body)).people });
    },
    ({ key, found }) => {
      people.value = found;
      checkedLookupsKey.value = key;
      reviewError.value = null;
    },
    (err) =>
      (reviewError.value = errorMessage(err, 'Couldn’t look for people already in the directory')),
  );

  watch([namesKey, reviewing], checkNames);
  watch([lookupsKey, reviewing], lookUp);

  /** Ask the directory again: after an error, or a final check that found it changed. */
  function recheckReview(): void {
    reviewError.value = null;
    checkedNamesKey.value = null;
    checkedLookupsKey.value = null;
    checkNames();
    lookUp();
  }

  const namesCurrent = computed(() => checkedNamesKey.value === namesKey.value);
  const lookupsCurrent = computed(() => checkedLookupsKey.value === lookupsKey.value);

  const approvedByRow = computed(() => {
    const map = new Map<number, Set<string>>();
    for (const entry of draft.approved) {
      const cut = entry.indexOf('\n');
      const row = Number(entry.slice(0, cut));
      if (!map.has(row)) map.set(row, new Set());
      map.get(row)!.add(entry.slice(cut + 1));
    }
    return map;
  });
  const approvalOf = (row: number, d: NamingDeviation) => `${row}\n${approvalKey(d)}`;
  const isApproved = (row: number, d: NamingDeviation) =>
    approvedByRow.value.get(row)?.has(approvalKey(d)) ?? false;
  function approve(row: number, d: NamingDeviation, yes = true): void {
    const entry = approvalOf(row, d);
    const rest = draft.approved.filter((a) => a !== entry);
    draft.approved = yes ? [...rest, entry] : rest;
  }

  const reviews = computed(() => {
    const found = lookupsCurrent.value ? people.value : null;
    const current = namesCurrent.value ? suggestions.value : new Map<number, NamingSuggestion>();
    const rows = included.value;
    const review = (
      row: number,
      manager: ManagerMatch = { kind: 'none' },
      conflicts: readonly string[] = [],
    ) =>
      reviewImportRow(values.value[row]!, {
        suggestion: current.get(row) ?? null,
        approved: approvedByRow.value.get(row) ?? new Set<string>(),
        people: found,
        manager,
        conflicts,
        phoneCountry: settings.value.phoneCountry,
      });
    const existing = new Set(rows.filter((row) => review(row).existing));
    const accounts: PlannedAccount[] = rows.flatMap((row) => {
      const s = current.get(row);
      if (!s || existing.has(row)) return [];
      const email = values.value[row]!.email || null;
      return [{ index: row, email, upn: s.upn, samAccountName: s.samAccountName }];
    });
    const conflicts = found
      ? addressConflicts(accounts, found, lineOf)
      : new Map<number, string[]>();
    const managers = found
      ? resolveManagers(
          rows.map((row) => ({ index: row, manager: values.value[row]!.manager })),
          accounts,
          found,
          lineOf,
        )
      : new Map<number, ManagerMatch>();
    return new Map<number, ReviewedRow>(
      rows.map((row) => {
        const manager = managers.get(row) ?? { kind: 'none' };
        return [
          row,
          {
            review: review(row, manager, conflicts.get(row)),
            suggestion: current.get(row) ?? null,
            manager,
          },
        ];
      }),
    );
  });

  const rowsOf = (status: ImportRowReview['status']) =>
    included.value.filter((row) => reviews.value.get(row)?.review.status === status);
  const pending = computed(() => !namesCurrent.value || !lookupsCurrent.value);
  const toCreate = computed(() =>
    included.value.filter((row) => !reviews.value.get(row)?.review.existing),
  );

  const deviationsOf = (pick: (d: NamingDeviation) => boolean): RowDeviation[] =>
    toCreate.value.flatMap((row) =>
      (reviews.value.get(row)?.suggestion?.deviations ?? [])
        .filter(pick)
        .map((deviation) => ({ ...rowRef(row), deviation })),
    );
  /** Approved together, with Approve all; each value can be typed instead. */
  const truncations = computed(() => deviationsOf((d) => d.kind === 'truncated'));
  /** Approved one at a time. */
  const individual = computed(() => deviationsOf((d) => d.approval === 'individual'));
  /** Shown, never held for approval. */
  const normalizations = computed(() => deviationsOf((d) => d.kind === 'normalized'));
  const cnCollisions = computed(() => deviationsOf((d) => d.kind === 'cn_collision'));

  function approveAllTruncations(): void {
    const entries = truncations.value.map(({ row, deviation }) => approvalOf(row, deviation));
    draft.approved = [...new Set([...draft.approved, ...entries])];
  }
  const unapprovedTruncations = computed(
    () => truncations.value.filter(({ row, deviation }) => !isApproved(row, deviation)).length,
  );

  const blockedRows = computed(() =>
    rowsOf('blocked').map((row) => ({
      ...rowRef(row),
      blockers: reviews.value.get(row)!.review.blockers,
    })),
  );
  const warnedRows = computed(() =>
    toCreate.value.flatMap((row) => {
      const warnings = reviews.value.get(row)?.review.warnings ?? [];
      return warnings.length ? [{ ...rowRef(row), warnings }] : [];
    }),
  );
  /** Rows that are someone already in the directory: skipped, as an import only creates. */
  const skipped = computed(() =>
    included.value.flatMap((row) => {
      const existing = reviews.value.get(row)?.review.existing;
      return existing ? [{ ...rowRef(row), existing }] : [];
    }),
  );
  const excludedRows = computed(() => draft.excluded.map(rowRef));

  /** What a name field shows: the typed value, else the check's. */
  function nameValue(row: number, field: keyof TypedNames): string {
    const typed = draft.typed[row]?.[field];
    if (typed !== undefined) return typed;
    const s = reviews.value.get(row)?.suggestion;
    if (!s) return '';
    return field === 'upnLocal' ? s.upnLocal : s[field];
  }
  function setName(row: number, field: keyof TypedNames, value: string): void {
    const typed = { ...draft.typed[row] };
    if (value.trim()) typed[field] = value.trim();
    else delete typed[field];
    draft.typed = { ...draft.typed, [row]: typed };
  }

  const namesReady = computed(
    () =>
      !pending.value &&
      !reviewError.value &&
      toCreate.value.length > 0 &&
      toCreate.value.every((row) => reviews.value.get(row)?.review.status === 'ready'),
  );

  // ---- Buckets, as placed --------------------------------------------------

  /**
   * What running the import remembers for a bucket: a placement the
   * operator chose replaces its rule, or becomes one. One it only started
   * with (the OU the import was started from) leaves a rule as it is.
   */
  function rememberedAs(
    key: string,
    placement: BucketPlacement,
    rule: PlacementRule | null,
  ): 'new' | 'update' | 'keep' | null {
    if (!groupBy.value || !placement.ouDn) return null;
    if (!rule) return 'new';
    if (!draft.placements[key]) return 'keep';
    const sameGroups =
      rule.groups.length === placement.groups.length &&
      rule.groups.every((g) => placement.groups.some((p) => p.id === g.id));
    return rule.ouDn.toLowerCase() === placement.ouDn.toLowerCase() && sameGroups
      ? 'keep'
      : 'update';
  }

  const buckets = computed(() =>
    allBuckets.value.map((b) => {
      const placement = placementOf(b.key);
      const rule = ruleFor(rules.value, groupBy.value, b);
      return {
        ...b,
        placement,
        rule,
        /** The rows the import creates. */
        creating: b.rows.filter((r) => !reviews.value.get(r)?.review.existing).length,
        remember: rememberedAs(b.key, placement, rule),
      };
    }),
  );
  const bucketProblems = computed(() =>
    buckets.value
      .filter((b) => b.creating > 0 && !b.placement.ouDn)
      .map((b) => `Pick an OU for ${b.label}.`),
  );

  // ---- Options -------------------------------------------------------------

  function setPasswordMode(mode: PasswordMode): void {
    draft.options.passwordMode = mode;
    password.value = '';
    draft.options.mustChange = true;
  }
  const passwordChecks = computed<PasswordCheck[]>(() =>
    draft.options.passwordMode === 'set'
      ? [
          ...checkPassword(password.value, policy.value, {
            samAccountName: null,
            displayName: null,
          }),
          {
            rule: 'formula',
            met: !startsLikeFormula(password.value),
            text: 'Doesn’t start with =, +, - or @ (the results spreadsheet would run it)',
          },
        ]
      : [],
  );
  const importPassword = computed<ImportPassword | null>(() => {
    const { passwordMode: mode, mustChange } = draft.options;
    if (mode === 'random') return { mode };
    if (mode === 'generate') return { mode, mustChange };
    return passwordChecks.value.every((c) => c.met)
      ? { mode, password: password.value, mustChange }
      : null;
  });
  const mustChangeNote = computed(() =>
    draft.options.passwordMode === 'random' ? RANDOM_MODE_MUST_CHANGE_NOTE : null,
  );

  // ---- Issue TAPs for class --------------------------------------------------

  /** Whether the directory and the tenant let an import issue class passes, and within what. */
  const classTapOptions = shallowRef<ClassTapOptions | null>(null);
  const classTapError = ref<string | null>(null);
  const canIssueTaps = computed(() => auth.hasCapability('write:user.issueTap'));
  const classPolicy = computed(() =>
    classTapOptions.value?.status === 'ready' ? classTapOptions.value.policy : null,
  );
  /** The operator's time zone: a time of day for each person's start date is read in it. */
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startDateMapped = computed(() => draft.mapping.includes('startDate'));
  const classLifetimeOptions = computed(() =>
    classPolicy.value ? lifetimeOptionsFor(classPolicy.value) : [],
  );
  /** The tenant lets a pass be used more than once within its lifetime. */
  const multiUseAllowed = computed(() => classPolicy.value?.usableOnceOnly === false);

  async function loadClassTapOptions(): Promise<void> {
    classTapOptions.value = null;
    classTapError.value = null;
    if (!canIssueTaps.value) return;
    try {
      classTapOptions.value = await api.users.import.classTaps();
    } catch (err) {
      classTapError.value = errorMessage(
        err,
        'Couldn’t read the tenant’s Temporary Access Pass policy',
      );
    }
  }

  function setClassTap(on: boolean): void {
    const policy = classPolicy.value;
    const current: ClassTapDraft = draft.options.classTap ?? {
      on: false,
      date: '',
      time: '09:00',
      byStartDate: startDateMapped.value,
      ...(policy
        ? classTapDefaults(policy)
        : { lifetimeMinutes: CLASS_TAP_DEFAULT_LIFETIME_MINUTES, isUsableOnce: true }),
    };
    draft.options.classTap = { ...current, on };
  }

  /** What the run asks for its class; null when it issues no passes, or the start isn't set yet. */
  const classTapRequest = computed<ClassTapRequest | null>(() => {
    const ct = draft.options.classTap;
    const policy = classPolicy.value;
    if (!ct?.on || !policy) return null;
    const byStartDate = ct.byStartDate && startDateMapped.value;
    if (!ct.time) return null;
    const startsAt = fromLocalInputs(ct.date, ct.time);
    if (!byStartDate && !startsAt) return null;
    return {
      start: byStartDate
        ? { kind: 'startDate', time: ct.time, timeZone }
        : { kind: 'fixed', startsAt: startsAt! },
      lifetimeMinutes: ct.lifetimeMinutes,
      isUsableOnce: policy.usableOnceOnly || ct.isUsableOnce,
    };
  });

  /** Why the class's passes can't be issued as asked, by spreadsheet row where it's one row's. */
  const classTapIssues = computed(() => {
    if (!draft.options.classTap?.on) return [];
    const whole = (message: string) => [{ row: null, line: null, name: null, message }];
    if (classTapOptions.value?.status === 'unavailable') {
      return whole(classTapOptions.value.message);
    }
    if (!classPolicy.value) {
      return whole(classTapError.value ?? 'Reading the tenant’s Temporary Access Pass policy…');
    }
    const request = classTapRequest.value;
    if (!request) return whole('Choose when class starts.');
    const rows = toCreate.value;
    return classTapProblems(
      request,
      rows.map((row) => ({ startDate: reviews.value.get(row)?.review.startDate ?? null })),
      classPolicy.value,
    ).map((p) =>
      p.row === null
        ? { row: null, line: null, name: null, message: p.message }
        : { ...rowRef(rows[p.row]!), message: p.message },
    );
  });

  // ---- Final check ---------------------------------------------------------

  /** The import as the final check judges it and the run will make it; null until it's ready. */
  const importRequest = computed<ImportRequest | null>(() => {
    if (!namesReady.value || bucketProblems.value.length > 0 || !importPassword.value) return null;
    if (classTapIssues.value.length > 0) return null;
    const rows = toCreate.value;
    const position = new Map(rows.map((row, i) => [row, i]));
    const out: ImportRow[] = rows.map((row) => {
      const { review, suggestion, manager } = reviews.value.get(row)!;
      return importRowRequest({
        line: lineOf(row),
        values: values.value[row]!,
        review,
        suggestion: suggestion!,
        ouDn: ouOfRow(row)!,
        groups: canAddGroups.value
          ? placementOf(bucketOfRow.value.get(row)!).groups.map((g) => g.id)
          : [],
        manager,
        managerRow: manager.kind === 'row' ? position.get(manager.index) : undefined,
      });
    });
    return {
      rows: out,
      password: importPassword.value,
      enabled: draft.options.enabled,
      mailFromUpn: draft.options.mailFromUpn,
      ...(classTapRequest.value ? { classTap: classTapRequest.value } : {}),
    };
  });
  const requestKey = computed(() => JSON.stringify(importRequest.value));

  const checking = ref(false);
  const checkError = ref<string | null>(null);
  /** The last check, with the rows it was about. */
  const lastCheck = shallowRef<{ key: string; rows: number[]; answer: ImportCheckResponse } | null>(
    null,
  );
  const rulesError = ref<string | null>(null);
  const acknowledgedProtected = ref(false);

  function forgetCheck(): void {
    lastCheck.value = null;
    checkError.value = null;
    rulesError.value = null;
    acknowledgedProtected.value = false;
  }

  /** The check's answer, while the import is still as it was checked. */
  const result = computed(() =>
    lastCheck.value?.key === requestKey.value ? lastCheck.value.answer : null,
  );
  /** The import changed since the last check, so its answer is only a guide. */
  const checkStale = computed(() => !!lastCheck.value && !result.value);

  function runCheck(): void {
    if (!importRequest.value || checking.value) return;
    auth.requireStepUp(commitCheck, 'Importing users requires step-up authentication.');
  }

  async function commitCheck(): Promise<void> {
    const body = importRequest.value;
    if (!body || checking.value) return;
    const key = requestKey.value;
    const rows = [...toCreate.value];
    checking.value = true;
    checkError.value = null;
    try {
      const answer = await api.users.import.check(body);
      lastCheck.value = { key, rows, answer };
      acknowledgedProtected.value = false;
      // What changed in the directory shows in the review too, to fix there.
      if (answer.problems.length > 0) recheckReview();
    } catch (err) {
      if (auth.retryAfterStepUp(err, commitCheck)) return;
      checkError.value = errorMessage(err, 'Couldn’t run the final check');
    } finally {
      checking.value = false;
    }
  }

  /**
   * Remember where each bucket went, for the next import grouped by this
   * column: the run calls this once it starts. Not at the final check, so
   * an import abandoned there leaves the rules as they were.
   */
  async function rememberPlacements(): Promise<void> {
    const id = directoryId.value;
    const column = groupBy.value;
    if (!id || !column) return;
    const changed = buckets.value.filter(
      (b) => b.creating > 0 && (b.remember === 'new' || b.remember === 'update'),
    );
    if (changed.length === 0) return;
    rulesError.value = null;
    try {
      const saved = await api.directories.placementRules.save(id, {
        rules: changed.map((b) => ({
          column,
          value: b.key === '' ? '' : b.label,
          ouDn: b.placement.ouDn!,
          groupIds: canAddGroups.value ? b.placement.groups.map((g) => g.id) : [],
        })),
      });
      rules.value = saved.rules;
    } catch (err) {
      rulesError.value = errorMessage(err, 'Couldn’t save the placement rules');
    }
  }

  /** A check issue with the row it's about, as the spreadsheet numbers it. */
  const describeIssue = (issue: ImportCheckIssue) => {
    const row = issue.row === null ? null : (lastCheck.value?.rows[issue.row] ?? null);
    return { ...issue, ...(row === null ? { row: null, line: null, name: null } : rowRef(row)) };
  };
  const checkProblems = computed(() => lastCheck.value?.answer.problems.map(describeIssue) ?? []);
  const checkWarnings = computed(() => lastCheck.value?.answer.warnings.map(describeIssue) ?? []);
  const protectedGroups = computed(() => result.value?.protectedGroups ?? []);
  /** Passed, and the operator acknowledged any group AD protects: ready for the run. */
  const ready = computed(
    () =>
      !!result.value &&
      result.value.problems.length === 0 &&
      (protectedGroups.value.length === 0 || acknowledgedProtected.value),
  );

  // ---- Run -----------------------------------------------------------------

  const running = ref(false);
  const runError = ref<string | null>(null);
  /** The job the run started, whose results page comes next. */
  const startedJobId = ref<string | null>(null);

  function run(): void {
    if (!ready.value || running.value) return;
    auth.requireStepUp(commitRun, 'Importing users requires step-up authentication.');
  }

  async function commitRun(): Promise<void> {
    const body = importRequest.value;
    if (!body || !ready.value || running.value) return;
    running.value = true;
    runError.value = null;
    try {
      const { job } = await api.users.import.run({
        import: body,
        acknowledgeProtected: acknowledgedProtected.value,
      });
      await rememberPlacements();
      if (owner.value) clearDraft(owner.value);
      startedJobId.value = job.id;
    } catch (err) {
      if (auth.retryAfterStepUp(err, commitRun)) return;
      runError.value = errorMessage(err, 'Couldn’t start the import');
      // The server's check found something this one didn't: show what.
      if (err instanceof ApiError && err.status === 422) void commitCheck();
    } finally {
      running.value = false;
    }
  }

  // ---- Steps ---------------------------------------------------------------

  const stepIndex = computed(() => IMPORT_STEPS.indexOf(draft.step));
  const canContinue = computed(() => {
    const ready: Record<ImportStep, () => boolean> = {
      source: () => !!table.value && sourceProblems.value.length === 0,
      columns: () => columnProblems.value.length === 0,
      names: () => namesReady.value,
      buckets: () => namesReady.value && bucketProblems.value.length === 0,
      options: () => importRequest.value !== null,
      check: () => false,
    };
    return ready[draft.step]();
  });

  function next(): void {
    if (canContinue.value) draft.step = IMPORT_STEPS[stepIndex.value + 1]!;
  }
  function back(): void {
    if (stepIndex.value > 0) draft.step = IMPORT_STEPS[stepIndex.value - 1]!;
  }
  /** Go back to an earlier step; later ones are reached with Next. */
  function goTo(step: ImportStep): void {
    if (IMPORT_STEPS.indexOf(step) < stepIndex.value) draft.step = step;
  }

  return {
    draft,
    start,
    startOver,
    loading,
    loadError,
    naming,
    settings,
    stepIndex,
    canContinue,
    next,
    back,
    goTo,
    // Source
    table,
    paste,
    readFile,
    sourceError,
    sourceProblems,
    headerMissing,
    templateCsv: importTemplateCsv,
    // Columns
    setMapping,
    fieldOptions,
    columnProblems,
    preview,
    usageLocationNote,
    // Names
    values,
    lineOf,
    nameOf,
    pending,
    reviewError,
    retryReview: recheckReview,
    reviews,
    toCreate,
    truncations,
    unapprovedTruncations,
    approveAllTruncations,
    individual,
    normalizations,
    cnCollisions,
    blockedRows,
    warnedRows,
    skipped,
    excludedRows,
    exclude,
    include,
    isApproved,
    approve,
    nameValue,
    setName,
    namesReady,
    // Buckets
    groupBy,
    groupByOptions,
    setGroupBy,
    buckets,
    bucketProblems,
    setBucketOu,
    addBucketGroup,
    removeBucketGroup,
    useRule,
    moveRow,
    canAddGroups,
    groupSearch,
    // Options
    password,
    passwordChecks,
    setPasswordMode,
    mustChangeNote,
    // Issue TAPs for class
    canIssueTaps,
    classTapOptions,
    classTapError,
    classPolicy,
    classLifetimeOptions,
    multiUseAllowed,
    startDateMapped,
    timeZone,
    setClassTap,
    classTapRequest,
    classTapIssues,
    // Final check
    importRequest,
    runCheck,
    checking,
    checkError,
    result,
    checkStale,
    rememberPlacements,
    checkProblems,
    checkWarnings,
    protectedGroups,
    acknowledgedProtected,
    rulesError,
    ready,
    // Run
    run,
    running,
    runError,
    startedJobId,
  };
}
