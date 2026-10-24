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
  /** How many of those the preview doesn't list. */
  unlisted: number;
  /** Why the operator can't make this change, when they can't. */
  blocked: string | null;
}

/** A membership job as previewed, ready to start. */
export interface GroupChange {
  op: BulkMembershipOp;
  ids: string[];
  groupIds: string[];
  previewToken: string;
  /** The operator ticked that the users gain admin rights in AD. */
  acknowledgeProtected: boolean;
}

export function describeGroupPreview(
  op: BulkMembershipOp,
  group: BulkGroupPreviewGroup,
  canGrantRoles = true,
): GroupPreviewLine {
  const { changes, unchanged, indirect } = group;
  const summary =
    op === 'add'
      ? `${changes} will be added · ${unchanged.count} ${unchanged.count === 1 ? 'is already a member' : 'are already members'}`
      : `${changes} will be removed · ${unchanged.count} ${unchanged.count === 1 ? 'isn’t a member' : 'aren’t members'}`;
  const n = indirect.count;
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
    unlisted: unchanged.count - unchanged.users.length,
    blocked:
      op === 'add' && group.privilege?.reason === 'role' && !canGrantRoles
        ? 'Adding members hands out an OpenADUC role, which takes the configure:security capability. Ask an admin.'
        : null,
  };
}

export function useBulkGroupMembership(options: {
  /** The selected users, read when the preview is asked for. */
  ids: () => string[];
  /** Start the job on what was previewed; useBulkActions prompts step-up first. */
  start: (change: GroupChange) => void;
  /** Whether the operator may add members to a group mapped to an OpenADUC role. */
  canGrantRoles?: () => boolean;
}) {
  const visible = ref(false);
  const op = ref<BulkMembershipOp>('add');
  const chosen = ref<GroupSummary[]>([]);
  const preview = shallowRef<BulkGroupMembershipPreview | null>(null);
  // What the preview was asked for, which the job then runs on.
  let previewed: { ids: string[]; groupIds: string[] } | null = null;
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
      ? preview.value.groups.map((g) =>
          describeGroupPreview(preview.value!.op, g, options.canGrantRoles?.() ?? true),
        )
      : [],
  );
  // Nothing to start when every user is already as asked in every group.
  const changes = computed(() => lines.value.reduce((n, l) => n + l.group.changes, 0));
  /** The groups AD protects that an add would put these users in. */
  const protectedGroups = computed(() =>
    preview.value?.op === 'add'
      ? lines.value.filter((l) => l.group.privilege?.reason === 'protected').map((l) => l.group)
      : [],
  );
  const acknowledged = ref(false);
  const acknowledgement = computed(() =>
    protectedGroups.value.length === 0
      ? null
      : `I understand these users gain admin rights in AD through ${groupNames(protectedGroups.value)}.`,
  );
  const canConfirm = computed(
    () =>
      preview.value !== null &&
      changes.value > 0 &&
      lines.value.every((l) => !l.blocked) &&
      (acknowledgement.value === null || acknowledged.value),
  );

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
    previewed = null;
    acknowledged.value = false;
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
    const asked = { ids: options.ids(), groupIds: chosen.value.map((g) => g.id) };
    try {
      const result = await api.users.previewGroupChange({ op: op.value, ...asked });
      if (isCurrent()) {
        preview.value = result;
        previewed = asked;
      }
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
    const shown = preview.value;
    if (!shown || !previewed || !canConfirm.value) return;
    const { ids, groupIds } = previewed;
    const now = new Set(options.ids());
    if (now.size !== ids.length || ids.some((id) => !now.has(id))) {
      forgetPreview();
      previewError.value = 'The selection changed since the preview. Preview it again.';
      return;
    }
    const change: GroupChange = {
      op: shown.op,
      ids,
      groupIds,
      previewToken: shown.previewToken,
      acknowledgeProtected: acknowledgement.value !== null,
    };
    close();
    options.start(change);
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
    acknowledged,
    acknowledgement,
    canConfirm,
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
