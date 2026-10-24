// SPDX-License-Identifier: BUSL-1.1
// Revert a bulk job, from its audit log entry or from its panel once it
// has stopped: preview, from the cache, whom it puts back and what, who
// has changed again since the job (left as they are unless the operator
// ticks them) and whom it can't revert; then confirm with the count,
// which starts the revert as a job of its own on the page's bulk actions,
// prompting step-up first.

import { computed, ref, shallowRef } from 'vue';
import {
  BULK_ATTRIBUTE_FIELDS,
  BULK_JOB_CAPABILITIES,
  type AuditBulkSummary,
  type BulkJob,
  type BulkJobKind,
  type BulkJobRevertPreview,
  type BulkRevertChange,
  type BulkRevertField,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { expiryMoment } from '../lib/accountExpiry.js';
import { ATTRIBUTE_LABELS, shownValue } from '../lib/bulkAttributes.js';
import { accounts } from '../lib/bulkJob.js';
import { dnName } from '../lib/dn.js';
import type { useBulkActions } from './useBulkActions.js';

/** The job to revert, as the dialog names it. */
export interface RevertEntry {
  jobId: string;
  /** Its heading, e.g. "Bulk disable by Jane Doe: 42 users". */
  title: string;
  action: BulkJobKind;
}

type Value = string | boolean | null;

const text = (v: Value) => shownValue(typeof v === 'string' ? v : null);
const yesNo = (v: Value) => (v ? 'Yes' : 'No');

/** What each thing a revert changes is called, and how its values read. */
const REVERT_FIELDS: Record<BulkRevertField, { label: string; value: (v: Value) => string }> = {
  ...(Object.fromEntries(
    BULK_ATTRIBUTE_FIELDS.map((f) => [f, { label: ATTRIBUTE_LABELS[f], value: text }]),
  ) as Record<
    (typeof BULK_ATTRIBUTE_FIELDS)[number],
    { label: string; value: (v: Value) => string }
  >),
  enabled: { label: 'Account', value: (v) => (v ? 'Enabled' : 'Disabled') },
  ou: { label: 'OU', value: (v) => (typeof v === 'string' ? dnName(v) : text(null)) },
  accountExpires: {
    label: 'Account expires',
    value: (v) => (typeof v === 'string' ? expiryMoment(v) : 'Never'),
  },
  passwordMustChange: { label: 'Must change password', value: yesNo },
  passwordNeverExpires: { label: 'Password never expires', value: yesNo },
  group: { label: 'Group', value: (v) => (v ? 'Member' : 'Not a member') },
};

/** What a change is to: a field, the account, or a group by name. */
export const revertChangeLabel = (change: BulkRevertChange): string =>
  change.field === 'group' && change.group ? change.group : REVERT_FIELDS[change.field].label;

export const revertValueText = (field: BulkRevertField, value: Value): string =>
  REVERT_FIELDS[field].value(value);

/** The revert last started from the audit log, so coming back there shows it. */
const REVERT_KEY = 'openaduc.bulkRevert.job';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useBulkJobRevert(options: {
  /** The page's bulk actions, whose panel follows the revert once it starts. */
  bulk: ReturnType<typeof useBulkActions>;
  /** Hears of the revert's job, as the page remembers its jobs. */
  started?: (job: BulkJob) => void;
}) {
  const auth = useAuthStore();
  const entry = shallowRef<RevertEntry | null>(null);
  const visible = computed(() => entry.value !== null);
  const preview = shallowRef<BulkJobRevertPreview | null>(null);
  const previewing = ref(false);
  const previewError = ref<string | null>(null);
  const included = ref(new Set<string>());
  const includeAll = ref(false);
  const acknowledged = ref(false);
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
    acknowledged.value = false;
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

  function setAcknowledged(yes: boolean): void {
    acknowledged.value = yes;
  }

  const count = computed(() => {
    const p = preview.value;
    if (!p) return 0;
    return p.revert.count + (includeAll.value ? p.modified.count : included.value.size);
  });
  const needsAcknowledgement = computed(() => (preview.value?.protectedGroups.length ?? 0) > 0);
  const canConfirm = computed(
    () => count.value > 0 && (!needsAcknowledgement.value || acknowledged.value),
  );
  const confirmLabel = computed(() => `Revert ${accounts(count.value)}`);
  const caveat = computed(() =>
    entry.value?.action === 'user.passwordMustChange.set'
      ? 'They won’t have to change their password any more, but AD can’t put back when it was last set: their password’s age starts again from now.'
      : null,
  );

  function confirm(): void {
    const current = entry.value;
    const p = preview.value;
    if (!current || !p || !canConfirm.value) return;
    const include = includeAll.value ? ('all' as const) : [...included.value];
    const acknowledgeProtected = needsAcknowledgement.value && acknowledged.value;
    close();
    options.bulk.startRevert(
      current.jobId,
      { previewToken: p.previewToken, include, acknowledgeProtected },
      (job) => {
        try {
          localStorage.setItem(REVERT_KEY, job.id);
        } catch {
          // Without storage, coming back doesn't show the revert.
        }
        options.started?.(job);
      },
    );
  }

  /** Coming back to the audit log: show the revert last started, unless it's old news or dismissed. */
  function restore(): void {
    let id: string | null = null;
    try {
      id = localStorage.getItem(REVERT_KEY);
    } catch {
      // Without storage there's nothing to show.
    }
    if (id) void options.bulk.restore(id);
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
    acknowledged,
    setAcknowledged,
    needsAcknowledgement,
    count,
    canConfirm,
    confirmLabel,
    caveat,
    canRevert,
    open,
    close,
    confirm,
    restore,
  };
}
