// SPDX-License-Identifier: BUSL-1.1
// Reassign a departing manager's direct reports: select some or all of
// them, pick the new manager, see each report's manager change (the bulk
// edit's preview, setting only the manager), then confirm, which starts
// the bulk edit's job (useBulkActions.startAttributeEdit) and prompts
// step-up first.

import { computed, ref, shallowRef, type Ref } from 'vue';
import type { BulkUserAttributesRequest, UserDetail, UserSummary } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { rdns } from '../lib/dn.js';
import { useAttributeEditPreview } from './useAttributeEditPreview.js';
import { useDebouncedSearch } from './useDebouncedSearch.js';

const MANAGER_SEARCH_DELAY_MS = 200;
const MANAGER_PAGE_SIZE = 12;

export interface ListedReport {
  id: string;
  name: string;
  disabled: boolean;
}

const reportsText = (n: number): string => (n === 1 ? '1 report' : `${n} reports`);

export function useReassignReports(options: {
  /** The departing manager. */
  manager: () => Pick<UserDetail, 'id' | 'directReports'> | null;
  /** The reports selected; the job leaves the ones it failed selected. */
  selected: Ref<Set<string>>;
  /** Start the job on what was previewed; useBulkActions prompts step-up first. */
  start: (edit: BulkUserAttributesRequest) => void;
}) {
  const { selected } = options;
  const visible = ref(false);
  const previewStep = useAttributeEditPreview();
  const { preview, previewing, mayChange, forget: forgetPreview } = previewStep;

  // Only reports the cache holds have an id the job can take.
  const reports = computed<ListedReport[]>(() =>
    (options.manager()?.directReports ?? [])
      .filter((r): r is typeof r & { id: string } => r.id !== null)
      .map((r) => ({
        id: r.id,
        name: r.displayName ?? rdns(r.distinguishedName)[0]!.replace(/^CN=/i, ''),
        disabled: r.enabled === false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const notListed = computed(
    () => (options.manager()?.directReports.length ?? 0) - reports.value.length,
  );
  const selectedIds = computed(() =>
    reports.value.filter((r) => selected.value.has(r.id)).map((r) => r.id),
  );
  const selectedCount = computed(() => selectedIds.value.length);
  const allSelected = computed(
    () => reports.value.length > 0 && selectedCount.value === reports.value.length,
  );

  const newManager = shallowRef<{ id: string; name: string } | null>(null);
  const managerSearch = useDebouncedSearch<UserSummary>({
    delayMs: MANAGER_SEARCH_DELAY_MS,
    search: (q) => api.users.search({ q, pageSize: MANAGER_PAGE_SIZE }),
  });
  // They're the one leaving.
  const managerResults = computed(() =>
    managerSearch.results.value.filter((u) => u.id !== options.manager()?.id),
  );

  const canPreview = computed(
    () => selectedIds.value.length > 0 && newManager.value !== null && !previewing.value,
  );
  const title = computed(() =>
    preview.value
      ? `Reassign ${selectedCount.value === 1 ? '1 direct report' : `${selectedCount.value} direct reports`}?`
      : 'Reassign direct reports',
  );
  const confirmLabel = computed(() => `Reassign ${reportsText(mayChange.value)}`);

  function select(ids: Iterable<string>): void {
    selected.value = new Set(ids);
    forgetPreview();
  }

  function isSelected(id: string): boolean {
    return selected.value.has(id);
  }

  function toggle(id: string): void {
    const next = new Set(selectedIds.value);
    if (!next.delete(id)) next.add(id);
    select(next);
  }

  const selectAll = () => select(reports.value.map((r) => r.id));
  const selectNone = () => select([]);

  function chooseManager(user: UserSummary): void {
    newManager.value = { id: user.id, name: user.displayName ?? user.samAccountName };
    managerSearch.reset();
    forgetPreview();
  }

  /** Every report, unless a job left some of them selected. */
  function open(): void {
    newManager.value = null;
    managerSearch.reset();
    select(selectedIds.value.length > 0 ? selectedIds.value : reports.value.map((r) => r.id));
    visible.value = true;
  }

  function close(): void {
    visible.value = false;
    forgetPreview();
  }

  async function review(): Promise<void> {
    if (!canPreview.value) return;
    await previewStep.review(selectedIds.value, { manager: newManager.value!.id });
  }

  function confirm(): void {
    const edit = previewStep.request(selectedIds.value);
    if (!edit) return;
    close();
    options.start(edit);
  }

  return {
    visible,
    title,
    confirmLabel,
    reports,
    notListed,
    selectedCount,
    allSelected,
    isSelected,
    toggle,
    selectAll,
    selectNone,
    newManager,
    managerQuery: managerSearch.query,
    managerResults,
    managerSearching: managerSearch.searching,
    managerSearchError: managerSearch.searchError,
    chooseManager,
    canPreview,
    preview,
    previewing,
    previewError: previewStep.previewError,
    canConfirm: previewStep.canConfirm,
    hasMore: previewStep.hasMore,
    loadingMore: previewStep.loadingMore,
    showMore: previewStep.showMore,
    open,
    close,
    review,
    back: forgetPreview,
    confirm,
  };
}
