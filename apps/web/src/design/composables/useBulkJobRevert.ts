// SPDX-License-Identifier: BUSL-1.1
// Revert a bulk job from its entry in the audit log: preview, from the
// cache, whom it puts back and what, who has changed again since the job
// (left as they are unless the operator includes them) and whom it can't
// revert; then confirm with the count, which starts the revert as a job
// of its own (useBulkActions.startRevert), prompting step-up first. The
// audit log follows that job, and shows it again on coming back.

import { computed, ref, shallowRef } from 'vue';
import type { ToastServiceMethods } from 'primevue/toastservice';
import {
  BULK_JOB_CAPABILITIES,
  type AuditBulkSummary,
  type BulkJobRevertPreview,
  type BulkRevertChange,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { expiryMoment } from '../lib/accountExpiry.js';
import { ATTRIBUTE_LABELS, shownValue } from '../lib/bulkAttributes.js';
import { accounts } from '../lib/bulkJob.js';
import { dnName } from '../lib/dn.js';
import { useBulkActions } from './useBulkActions.js';

/** The job's entry in the audit log. */
export interface RevertEntry {
  jobId: string;
  /** Its heading, e.g. "Bulk disable by Jane Doe: 42 users". */
  title: string;
  bulk: AuditBulkSummary;
}

/** The revert last started here, so coming back to the audit log shows it. */
const REVERT_KEY = 'openaduc.bulkRevert.job';

function storedRevert(): string | null {
  try {
    return localStorage.getItem(REVERT_KEY);
  } catch {
    return null;
  }
}

function rememberRevert(id: string): void {
  try {
    localStorage.setItem(REVERT_KEY, id);
  } catch {
    // Without storage, coming back doesn't show the revert.
  }
}

/** What a change is to: a field, the account, or a group by name. */
export function revertChangeLabel(change: BulkRevertChange): string {
  switch (change.field) {
    case 'enabled':
      return 'Account';
    case 'ou':
      return 'OU';
    case 'accountExpires':
      return 'Account expires';
    case 'passwordMustChange':
      return 'Must change password';
    case 'passwordNeverExpires':
      return 'Password never expires';
    case 'group':
      return change.group ?? 'Group';
    default:
      return ATTRIBUTE_LABELS[change.field];
  }
}

/** One of a change's values, as shown. */
export function revertValueText(
  field: BulkRevertChange['field'],
  value: string | boolean | null,
): string {
  if (field === 'enabled') return value ? 'Enabled' : 'Disabled';
  if (field === 'group') return value ? 'Member' : 'Not a member';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'accountExpires') return value === null ? 'Never' : expiryMoment(value);
  if (field === 'ou' && value !== null) return dnName(value);
  return shownValue(value);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useBulkJobRevert(options: {
  toast: Pick<ToastServiceMethods, 'add'>;
  /** Reload the audit log once the revert finishes. */
  reload: () => Promise<void>;
}) {
  const auth = useAuthStore();
  const bulk = useBulkActions({
    selectedIds: ref(new Set<string>()),
    toast: options.toast,
    reload: options.reload,
  });
  const entry = shallowRef<RevertEntry | null>(null);
  const visible = computed(() => entry.value !== null);
  const preview = shallowRef<BulkJobRevertPreview | null>(null);
  const previewing = ref(false);
  const previewError = ref<string | null>(null);
  // Users changed since the job that the operator chose to revert anyway.
  const included = ref(new Set<string>());
  const includeAll = ref(false);
  let asked = 0;

  /** Whether the operator may revert the entry's job, as far as the UI can tell. */
  function canRevert(summary: AuditBulkSummary | null): boolean {
    return !!summary?.revertible && auth.hasCapability(BULK_JOB_CAPABILITIES[summary.action]);
  }

  async function open(next: RevertEntry): Promise<void> {
    entry.value = next;
    preview.value = null;
    previewError.value = null;
    included.value = new Set();
    includeAll.value = false;
    const ask = ++asked;
    previewing.value = true;
    try {
      const result = await api.bulkJobs.revertPreview(next.jobId);
      if (ask === asked) preview.value = result;
    } catch (err) {
      if (ask === asked) previewError.value = message(err);
    } finally {
      if (ask === asked) previewing.value = false;
    }
  }

  function close(): void {
    asked++;
    entry.value = null;
    preview.value = null;
    previewing.value = false;
  }

  const isIncluded = (id: string): boolean => includeAll.value || included.value.has(id);

  function toggle(id: string): void {
    const next = new Set(included.value);
    if (!next.delete(id)) next.add(id);
    included.value = next;
  }

  function setIncludeAll(all: boolean): void {
    includeAll.value = all;
    if (!all) included.value = new Set();
  }

  const count = computed(() => {
    const p = preview.value;
    if (!p) return 0;
    return p.revert.count + (includeAll.value ? p.modified.count : included.value.size);
  });
  const canConfirm = computed(() => count.value > 0);
  const confirmLabel = computed(() => `Revert ${accounts(count.value)}`);
  /** What a revert can't put back exactly. */
  const caveat = computed(() =>
    entry.value?.bulk.action === 'user.passwordMustChange.set'
      ? 'They won’t have to change their password any more, but AD can’t put back when it was last set: their password’s age starts again from now.'
      : null,
  );

  /** Start the revert on what was previewed, prompting step-up first. */
  function confirm(): void {
    const current = entry.value;
    const p = preview.value;
    if (!current || !p || !canConfirm.value) return;
    const include = includeAll.value ? ('all' as const) : [...included.value];
    close();
    bulk.startRevert(current.jobId, { previewToken: p.previewToken, include }, (job) =>
      rememberRevert(job.id),
    );
  }

  /** Coming back: show the revert last started here, unless it's old news or dismissed. */
  function restore(): void {
    const id = storedRevert();
    if (id) void bulk.restore(id);
  }

  return {
    visible,
    entry,
    preview,
    previewing,
    previewError,
    isIncluded,
    includeAll,
    toggle,
    setIncludeAll,
    count,
    canConfirm,
    confirmLabel,
    caveat,
    canRevert,
    open,
    close,
    confirm,
    restore,
    job: bulk.job,
    jobBusy: bulk.busy,
    jobFailure: bulk.jobFailure,
    continueJob: bulk.continueJob,
    retryFailed: bulk.retryFailed,
    stopJob: bulk.stopJob,
    dismissJob: bulk.dismissJob,
  };
}
