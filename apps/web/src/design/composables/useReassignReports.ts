// SPDX-License-Identifier: BUSL-1.1
// Reassign a departing manager's direct reports: select some or all of
// them, pick the new manager, see each report's manager change (the bulk
// edit's preview, setting only the manager), then confirm, which starts
// the bulk edit's job (useBulkActions.startAttributeEdit) and prompts
// step-up first. The manager's page follows the job, and shows it again
// on coming back.

import { computed, ref, watch } from 'vue';
import type { ToastServiceMethods } from 'primevue/toastservice';
import type { UserDetail, UserSummary } from '@openaduc/shared';
import { bulkJobTitle } from '../lib/bulkJob.js';
import { dnName } from '../lib/dn.js';
import { useAttributeEditPreview } from './useAttributeEditPreview.js';
import { useBulkActions } from './useBulkActions.js';
import { useBulkJobRevert } from './useBulkJobRevert.js';
import { useUserPick } from './useUserPick.js';

export interface ListedReport {
  id: string;
  name: string;
  disabled: boolean;
}

const reportsText = (n: number): string => (n === 1 ? '1 report' : `${n} reports`);

/** Each manager's last reassignment job, newest last, so their page shows it on coming back. */
const JOBS_KEY = 'openaduc.reassignReports.jobs';
const JOBS_KEPT = 20;

function storedJobs(): [managerId: string, jobId: string][] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(JOBS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as [string, string][]) : [];
  } catch {
    return [];
  }
}

function rememberJob(managerId: string, jobId: string): void {
  const kept = storedJobs().filter(([m]) => m !== managerId);
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify([...kept, [managerId, jobId]].slice(-JOBS_KEPT)));
  } catch {
    // Without storage, coming back to the page doesn't show the job.
  }
}

const jobOf = (managerId: string): string | null =>
  storedJobs().find(([m]) => m === managerId)?.[1] ?? null;

export function useReassignReports(options: {
  /** The page's user, the departing manager, also while their record loads. */
  managerId: () => string;
  /** Their record, once loaded. */
  manager: () => Pick<UserDetail, 'id' | 'directReports'> | null;
  toast: Pick<ToastServiceMethods, 'add'>;
  /** Reload the manager once a job finishes. */
  reload: () => Promise<void>;
}) {
  // The reports ticked; the job leaves the ones it failed ticked.
  const selected = ref(new Set<string>());
  const bulk = useBulkActions({
    selectedIds: selected,
    toast: options.toast,
    reload: options.reload,
  });
  const jobRevert = useBulkJobRevert({
    bulk,
    started: (job) => rememberJob(options.managerId(), job.id),
  });
  const visible = ref(false);
  const {
    review: reviewEdit,
    request,
    forget: forgetPreview,
    ...previewState
  } = useAttributeEditPreview();
  const { preview, previewing, mayChange } = previewState;

  const hasReports = computed(() => (options.manager()?.directReports.length ?? 0) > 0);
  // Only reports the cache holds have an id the job can take.
  const reports = computed<ListedReport[]>(() =>
    (options.manager()?.directReports ?? [])
      .filter((r): r is typeof r & { id: string } => r.id !== null)
      .map((r) => ({
        id: r.id,
        name: r.displayName ?? dnName(r.distinguishedName),
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

  // They're the one leaving.
  const managerPick = useUserPick({ exclude: options.managerId });
  const newManager = managerPick.chosen;

  const canPreview = computed(
    () => selectedIds.value.length > 0 && newManager.value !== null && !previewing.value,
  );
  const title = computed(() =>
    preview.value ? `Reassign ${reportsText(selectedCount.value)}?` : 'Reassign direct reports',
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
    managerPick.choose(user);
    forgetPreview();
  }

  /** Every report, unless a job left some of them selected. */
  function open(): void {
    managerPick.reset();
    select(selectedIds.value.length > 0 ? selectedIds.value : reports.value.map((r) => r.id));
    visible.value = true;
  }

  function close(): void {
    visible.value = false;
    forgetPreview();
  }

  async function review(): Promise<void> {
    if (!canPreview.value) return;
    await reviewEdit(selectedIds.value, { manager: newManager.value!.id });
  }

  /** Start the job on what was previewed, prompting step-up first. */
  function confirm(): void {
    const edit = request(selectedIds.value);
    if (!edit) return;
    close();
    const managerId = options.managerId();
    bulk.startAttributeEdit(edit, (job) => rememberJob(managerId, job.id));
  }

  /** Revert the job shown, once it has stopped. */
  function revertJob(): void {
    const job = bulk.job.value;
    if (!job) return;
    void jobRevert.open({
      jobId: job.id,
      title: bulkJobTitle(job, job.counts.total, job.actorDisplayName),
      action: job.action,
    });
  }

  // Another user's page reuses this one: leave the last manager's job to
  // the list, and show this manager's, if they have one.
  watch(
    options.managerId,
    (managerId) => {
      bulk.detach();
      close();
      managerPick.reset();
      selected.value = new Set();
      const jobId = jobOf(managerId);
      if (jobId) void bulk.restore(jobId);
    },
    { immediate: true },
  );

  return {
    visible,
    title,
    confirmLabel,
    hasReports,
    reports,
    notListed,
    selectedCount,
    allSelected,
    isSelected,
    toggle,
    selectAll,
    selectNone,
    newManager,
    managerQuery: managerPick.query,
    managerResults: managerPick.results,
    managerSearching: managerPick.searching,
    managerSearchError: managerPick.searchError,
    chooseManager,
    canPreview,
    ...previewState,
    job: bulk.job,
    jobBusy: bulk.busy,
    jobRunning: bulk.bulkRunning,
    jobFailure: bulk.jobFailure,
    errors: bulk.bulkErrors,
    continueJob: bulk.continueJob,
    retryFailed: bulk.retryFailed,
    stopJob: bulk.stopJob,
    dismissJob: bulk.dismissJob,
    jobRevert,
    revertJob,
    open,
    close,
    review,
    back: forgetPreview,
    confirm,
  };
}
