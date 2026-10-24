// SPDX-License-Identifier: BUSL-1.1
// Add a selection of users to groups, or remove them from groups: pick
// the groups, see what it would change (from the cache, nothing written),
// then confirm, which starts a bulk job (useBulkActions.startGroupChange)
// and prompts step-up first.

import { computed, ref, shallowRef } from 'vue';
import {
  MAX_BULK_GROUPS,
  type BulkGroupMembershipPreview,
  type BulkGroupPreviewGroup,
  type BulkMembershipOp,
  type GroupSummary,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { accounts, groupNames } from '../lib/bulkJob.js';
import { latestRequest } from '../lib/latestRequest.js';
import { privilegeNote } from '../lib/newUser.js';
import { GROUP_PAGE_SIZE, MIN_GROUP_QUERY } from './useAddToGroup.js';
import { useDebouncedSearch } from './useDebouncedSearch.js';

const SEARCH_DELAY_MS = 200;

const users = (n: number): string => (n === 1 ? '1 user' : `${n} users`);
const are = (n: number): string => (n === 1 ? 'is' : 'are');

/** How one group's line in the preview reads. */
export interface GroupPreviewLine {
  group: BulkGroupPreviewGroup;
  /** "38 will be added · 4 are already members" */
  summary: string;
  /** Who's in only through a nested group (or their primary group), and what that means here. */
  indirect: string | null;
  /** Why changing this group's members deserves a second thought. */
  warning: string | null;
  /** The heading over the users the job leaves alone. */
  unchangedLabel: string;
}

export function describeGroupPreview(
  op: BulkMembershipOp,
  group: BulkGroupPreviewGroup,
): GroupPreviewLine {
  const { changes, unchanged, indirect } = group;
  const summary =
    op === 'add'
      ? `${changes} will be added · ${unchanged.length} ${unchanged.length === 1 ? 'is already a member' : 'are already members'}`
      : `${changes} will be removed · ${unchanged.length} ${unchanged.length === 1 ? 'isn’t a member' : 'aren’t members'}`;
  const n = indirect.length;
  const indirectNote =
    n === 0
      ? null
      : op === 'add'
        ? `${users(n)} ${are(n)} in it only through a nested group; they’ll be added directly.`
        : `${users(n)} ${are(n)} in it through a nested group or as their primary group, and will stay in it.`;
  return {
    group,
    summary,
    indirect: indirectNote,
    warning: group.privilege ? privilegeNote(group.privilege) : null,
    unchangedLabel: op === 'add' ? 'Already members' : 'Not members',
  };
}

export function useBulkGroupMembership(options: {
  /** The selected users, read when the preview is asked for. */
  ids: () => string[];
  /** Start the job; useBulkActions prompts step-up first. */
  start: (op: BulkMembershipOp, groupIds: string[]) => void;
}) {
  const visible = ref(false);
  const op = ref<BulkMembershipOp>('add');
  const chosen = ref<GroupSummary[]>([]);
  const preview = shallowRef<BulkGroupMembershipPreview | null>(null);
  const previewing = ref(false);
  const previewError = ref<string | null>(null);
  const previews = latestRequest();
  const search = useDebouncedSearch<GroupSummary>({
    minLength: MIN_GROUP_QUERY,
    delayMs: SEARCH_DELAY_MS,
    search: (q) => api.groups.search({ q, pageSize: GROUP_PAGE_SIZE }),
  });

  const count = computed(() => options.ids().length);
  const isChosen = (id: string): boolean => chosen.value.some((g) => g.id === id);
  const full = computed(() => chosen.value.length >= MAX_BULK_GROUPS);
  const canPreview = computed(() => chosen.value.length > 0 && count.value > 0);
  const lines = computed(() =>
    preview.value
      ? preview.value.groups.map((g) => describeGroupPreview(preview.value!.op, g))
      : [],
  );
  // Nothing to start when every user is already as asked in every group.
  const changes = computed(() => lines.value.reduce((n, l) => n + l.group.changes, 0));

  const title = computed(() => {
    const who = accounts(count.value);
    if (preview.value) {
      const groups = groupNames(preview.value.groups);
      return op.value === 'add' ? `Add ${who} to ${groups}?` : `Remove ${who} from ${groups}?`;
    }
    return op.value === 'add' ? `Add ${who} to groups` : `Remove ${who} from groups`;
  });
  const confirmLabel = computed(() => {
    const n = chosen.value.length;
    const groups = n === 1 ? 'group' : `${n} groups`;
    return op.value === 'add' ? `Add to ${groups}` : `Remove from ${groups}`;
  });

  function forgetPreview(): void {
    previews.begin();
    preview.value = null;
    previewing.value = false;
    previewError.value = null;
  }

  function open(initial: BulkMembershipOp = 'add'): void {
    op.value = initial;
    chosen.value = [];
    search.reset();
    forgetPreview();
    visible.value = true;
  }

  function close(): void {
    visible.value = false;
    forgetPreview();
  }

  /** Switching between add and remove keeps the groups but asks again what it'd change. */
  function setOp(next: BulkMembershipOp): void {
    if (next === op.value) return;
    op.value = next;
    forgetPreview();
  }

  function choose(group: GroupSummary): void {
    if (isChosen(group.id) || full.value) return;
    chosen.value = [...chosen.value, group];
    forgetPreview();
  }

  function unchoose(id: string): void {
    chosen.value = chosen.value.filter((g) => g.id !== id);
    forgetPreview();
  }

  async function review(): Promise<void> {
    if (!canPreview.value) return;
    const isCurrent = previews.begin();
    previewing.value = true;
    previewError.value = null;
    try {
      const result = await api.users.previewGroupChange({
        op: op.value,
        ids: options.ids(),
        groupIds: chosen.value.map((g) => g.id),
      });
      if (isCurrent()) preview.value = result;
    } catch (err) {
      if (isCurrent()) previewError.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      if (isCurrent()) previewing.value = false;
    }
  }

  /** Back from the preview to change the groups. */
  function back(): void {
    forgetPreview();
  }

  function confirm(): void {
    if (!preview.value || changes.value === 0) return;
    const groupIds = chosen.value.map((g) => g.id);
    const action = op.value;
    close();
    options.start(action, groupIds);
  }

  return {
    visible,
    op,
    count,
    title,
    confirmLabel,
    query: search.query,
    queryTooShort: search.queryTooShort,
    results: search.results,
    total: search.total,
    searching: search.searching,
    searchError: search.searchError,
    chosen,
    isChosen,
    full,
    canPreview,
    preview,
    previewing,
    previewError,
    lines,
    changes,
    open,
    close,
    setOp,
    choose,
    unchoose,
    review,
    back,
    confirm,
  };
}
