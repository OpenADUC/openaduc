// SPDX-License-Identifier: BUSL-1.1
// Import users from a spreadsheet, from the user list or from an OU (which
// every bucket then starts in). Six steps: the source, which column is
// which, the names, the buckets rows are placed in, the options, and the
// final check right before the run.
//
// The draft lives in sessionStorage (importDraft.ts). Before the final
// check the server is only read from: the naming check and the lookup of
// who's already in the directory, both of which need it. What a row would
// create, what needs approving and what blocks is reviewImportRow's call,
// so the review and the final check decide alike. Running the import is
// the next step (#153): the wizard ends with the checked request.

import { computed, reactive, ref, shallowRef, watch } from 'vue';
import {
  DEFAULT_NEW_USER_SETTINGS,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABEL,
  IMPORT_MAX_ROWS,
  RANDOM_MODE_MUST_CHANGE_NOTE,
  approvalKey,
  bucketKey,
  bucketsOf,
  checkPassword,
  guessMapping,
  importRowRequest,
  importTemplateCsv,
  importValues,
  lookupsOf,
  mappingProblems,
  namingRequestOf,
  parseTable,
  resolveManager,
  reviewImportRow,
  ruleFor,
  startingPlacement,
  type BatchAccount,
  type BucketPlacement,
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
  type ManagerMatch,
  type NamingDeviation,
  type NamingSettings,
  type NamingSuggestion,
  type NewUserSettings,
  type PasswordMode,
  type PlacementRule,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';
import {
  IMPORT_STEPS,
  clearDraft,
  loadDraft,
  saveDraft,
  type ImportDraft,
  type ImportStep,
  type TypedNames,
} from '../lib/importDraft.js';
import { latestRequest } from '../lib/latestRequest.js';
import { GROUP_PAGE_SIZE, MIN_GROUP_QUERY } from './useAddToGroup.js';
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

export function useUserImport() {
  const auth = useAuthStore();
  const draft = reactive<ImportDraft>(blankDraft(null, DEFAULT_NEW_USER_SETTINGS));
  const directoryId = ref<number | null>(null);
  const naming = ref<NamingSettings | null>(null);
  const settings = ref<NewUserSettings>({ ...DEFAULT_NEW_USER_SETTINGS });
  const policy = ref<DirectoryPolicy | null>(null);
  const rules = shallowRef<PlacementRule[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  /** The shared password in `set` mode; kept out of the draft. */
  const password = ref('');

  /**
   * Load the directory's settings and resume the draft, unless it's
   * still empty and the import was started from an OU.
   */
  async function start(startOuDn: string | null = null): Promise<void> {
    const id = auth.actor?.directoryId ?? null;
    directoryId.value = id;
    loadError.value = null;
    if (!id) return;
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
    const saved = loadDraft(id);
    const fresh = !saved || (!saved.table && startOuDn !== null);
    Object.assign(draft, fresh ? blankDraft(startOuDn, settings.value) : saved);
  }

  watch(
    draft,
    () => {
      if (directoryId.value) saveDraft(directoryId.value, draft);
    },
    { deep: true },
  );

  /** Forget the draft and start again from the source. */
  function startOver(): void {
    if (directoryId.value) clearDraft(directoryId.value);
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

  /** Rows pasted from a spreadsheet. */
  function paste(text: string): void {
    sourceError.value = null;
    if (text.trim()) useTable(text, null);
  }

  /** A CSV file dropped or picked. Excel workbooks are refused: save them as CSV. */
  async function readFile(file: File): Promise<void> {
    sourceError.value = null;
    const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    // .xlsx and .ods are zip archives; .xls is an OLE compound file.
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf;
    if (zip || ole || /\.(xlsx|xlsm|xls|ods|numbers)$/i.test(file.name)) {
      sourceError.value = `${file.name} is a workbook. Save it as CSV first, or copy the rows from Excel and paste them.`;
      return;
    }
    useTable(await file.text(), file.name);
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
  const nameChecks = latestRequest();
  const lookupChecks = latestRequest();
  let namesTimer: ReturnType<typeof setTimeout> | undefined;
  let lookupsTimer: ReturnType<typeof setTimeout> | undefined;

  function checkNames(): void {
    clearTimeout(namesTimer);
    const isCurrent = nameChecks.begin();
    const id = directoryId.value;
    if (!reviewing.value || !id) return;
    const key = namesKey.value;
    const requests = namingRequests.value;
    namesTimer = setTimeout(async () => {
      try {
        const r =
          requests.length === 0
            ? { suggestions: [] }
            : await api.directories.naming.check(id, {
                names: requests.map(({ request }) => ({
                  ...request.name,
                  ...(request.ouDn ? { ouDn: request.ouDn } : {}),
                  overrides: request.overrides,
                })),
              });
        if (!isCurrent()) return;
        suggestions.value = new Map(requests.map(({ row }, i) => [row, r.suggestions[i]!]));
        checkedNamesKey.value = key;
        reviewError.value = null;
      } catch (err) {
        if (isCurrent()) reviewError.value = errorMessage(err, 'Couldn’t check the names');
      }
    }, CHECK_DELAY_MS);
  }

  function lookUp(): void {
    clearTimeout(lookupsTimer);
    const isCurrent = lookupChecks.begin();
    if (!reviewing.value) return;
    const key = lookupsKey.value;
    const body = lookups.value;
    lookupsTimer = setTimeout(async () => {
      try {
        const r = await api.users.import.lookup(body);
        if (!isCurrent()) return;
        people.value = r.people;
        checkedLookupsKey.value = key;
        reviewError.value = null;
      } catch (err) {
        if (isCurrent()) {
          reviewError.value = errorMessage(
            err,
            'Couldn’t look for people already in the directory',
          );
        }
      }
    }, CHECK_DELAY_MS);
  }

  watch([namesKey, reviewing], checkNames);
  watch([lookupsKey, reviewing], lookUp);

  function retryReview(): void {
    reviewError.value = null;
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
    const out = new Map<number, ReviewedRow>();
    const first = new Map<number, ImportRowReview>();
    const context = (row: number, manager: ManagerMatch) => ({
      suggestion: current.get(row) ?? null,
      approved: approvedByRow.value.get(row) ?? new Set<string>(),
      people: found,
      manager,
      phoneCountry: settings.value.phoneCountry,
    });
    for (const row of included.value) {
      first.set(row, reviewImportRow(values.value[row]!, context(row, { kind: 'none' })));
    }
    const batch: BatchAccount[] = included.value.flatMap((row) => {
      const s = current.get(row);
      if (!s || first.get(row)!.existing) return [];
      const email = values.value[row]!.email || null;
      return [{ index: row, email, upn: s.upn, samAccountName: s.samAccountName }];
    });
    for (const row of included.value) {
      const v = values.value[row]!;
      const manager = found
        ? resolveManager(v.manager, row, batch, found)
        : { kind: 'none' as const };
      out.set(row, {
        review: v.manager ? reviewImportRow(v, context(row, manager)) : first.get(row)!,
        suggestion: current.get(row) ?? null,
        manager,
      });
    }
    return out;
  });

  const rowsOf = (status: ImportRowReview['status']) =>
    included.value.filter((row) => reviews.value.get(row)?.review.status === status);
  const pending = computed(() => !namesCurrent.value || !lookupsCurrent.value);
  const toCreate = computed(() =>
    included.value.filter((row) => !reviews.value.get(row)?.review.existing),
  );

  const deviationsOf = (pick: (d: NamingDeviation) => boolean): RowDeviation[] =>
    toCreate.value.flatMap((row) =>
      (reviews.value.get(row)?.suggestion?.deviations ?? []).filter(pick).map((deviation) => ({
        row,
        line: lineOf(row),
        name: nameOf(row),
        deviation,
      })),
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
      row,
      line: lineOf(row),
      name: nameOf(row),
      blockers: reviews.value.get(row)!.review.blockers,
    })),
  );
  const warnedRows = computed(() =>
    toCreate.value.flatMap((row) => {
      const warnings = reviews.value.get(row)?.review.warnings ?? [];
      return warnings.length ? [{ row, line: lineOf(row), name: nameOf(row), warnings }] : [];
    }),
  );
  /** Rows that are someone already in the directory: skipped, as an import only creates. */
  const skipped = computed(() =>
    included.value.flatMap((row) => {
      const existing = reviews.value.get(row)?.review.existing;
      return existing ? [{ row, line: lineOf(row), name: nameOf(row), existing }] : [];
    }),
  );
  const excludedRows = computed(() =>
    draft.excluded.map((row) => ({ row, line: lineOf(row), name: nameOf(row) })),
  );

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

  const buckets = computed(() =>
    allBuckets.value.map((b) => ({
      ...b,
      placement: placementOf(b.key),
      rule: ruleFor(rules.value, groupBy.value, b),
      /** The rows the import creates. */
      creating: b.rows.filter((r) => !reviews.value.get(r)?.review.existing).length,
    })),
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
  const passwordChecks = computed(() =>
    draft.options.passwordMode === 'set'
      ? checkPassword(password.value, policy.value, { samAccountName: null, displayName: null })
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

  // ---- Final check ---------------------------------------------------------

  /** The import as the final check judges it and the run will make it; null until it's ready. */
  const importRequest = computed<ImportRequest | null>(() => {
    if (!namesReady.value || bucketProblems.value.length > 0 || !importPassword.value) return null;
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
    };
  });
  const requestKey = computed(() => JSON.stringify(importRequest.value));

  const checking = ref(false);
  const checkError = ref<string | null>(null);
  const checkResult = shallowRef<ImportCheckResponse | null>(null);
  const checkedKey = ref<string | null>(null);
  const rulesError = ref<string | null>(null);
  const acknowledgedProtected = ref(false);

  function forgetCheck(): void {
    checkResult.value = null;
    checkedKey.value = null;
    checkError.value = null;
    rulesError.value = null;
    acknowledgedProtected.value = false;
  }

  /** The check's answer, while the import is still as it was checked. */
  const result = computed(() => (checkedKey.value === requestKey.value ? checkResult.value : null));

  function runCheck(): void {
    if (!importRequest.value || checking.value) return;
    auth.requireStepUp(commitCheck, 'Importing users requires step-up authentication.');
  }

  async function commitCheck(): Promise<void> {
    const body = importRequest.value;
    const id = directoryId.value;
    if (!body || !id || checking.value) return;
    const key = requestKey.value;
    checking.value = true;
    checkError.value = null;
    rulesError.value = null;
    try {
      const r = await api.users.import.check(body);
      checkResult.value = r;
      checkedKey.value = key;
      acknowledgedProtected.value = false;
      if (r.problems.length === 0) await saveRules(id);
    } catch (err) {
      if (auth.retryAfterStepUp(err, commitCheck)) return;
      checkError.value = errorMessage(err, 'Couldn’t run the final check');
    } finally {
      checking.value = false;
    }
  }

  /** Remember where each bucket went, for the next import grouped by this column. */
  async function saveRules(id: number): Promise<void> {
    const column = groupBy.value;
    if (!column) return;
    const placed = buckets.value.filter((b) => b.creating > 0 && b.placement.ouDn);
    if (placed.length === 0) return;
    try {
      const saved = await api.directories.placementRules.save(id, {
        rules: placed.map((b) => ({
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
    const row = issue.row === null ? null : (toCreate.value[issue.row] ?? null);
    return {
      ...issue,
      line: row === null ? null : lineOf(row),
      name: row === null ? null : nameOf(row),
    };
  };
  const checkProblems = computed(() => result.value?.problems.map(describeIssue) ?? []);
  const checkWarnings = computed(() => result.value?.warnings.map(describeIssue) ?? []);
  const protectedGroups = computed(() => result.value?.protectedGroups ?? []);
  /** Passed, and the operator acknowledged any group AD protects: ready for the run (#153). */
  const ready = computed(
    () =>
      !!result.value &&
      result.value.problems.length === 0 &&
      (protectedGroups.value.length === 0 || acknowledgedProtected.value),
  );

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
    // Names
    values,
    lineOf,
    nameOf,
    pending,
    reviewError,
    retryReview,
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
    // Final check
    importRequest,
    runCheck,
    checking,
    checkError,
    result,
    checkProblems,
    checkWarnings,
    protectedGroups,
    acknowledgedProtected,
    rulesError,
    ready,
  };
}
