// SPDX-License-Identifier: BUSL-1.1
// Move a selection of users to an OU, set when their accounts expire,
// make them change their password at next sign-in, or clear "password
// never expires": pick the change, see who it changes and who is
// already as asked (from the cache, nothing written), then confirm,
// which starts a bulk job (useBulkActions.startAccountChange) and
// prompts step-up first.

import { computed, ref, shallowRef } from 'vue';
import type {
  BulkAccountChange,
  BulkAccountNote,
  BulkAccountOp,
  BulkAccountPreview,
  BulkAccountPreviewUser,
  BulkAccountRequest,
  DirectoryOu,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { expiryAtEndOf, expiryMoment, expiryText } from '../lib/accountExpiry.js';
import { accounts } from '../lib/bulkJob.js';
import { latestRequest } from '../lib/latestRequest.js';

const message = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));
const users = (n: number): string => (n === 1 ? '1 user' : `${n} users`);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** How each change is offered, in the order the dialog offers them. */
export const ACCOUNT_OP_LABELS: Record<BulkAccountOp, string> = {
  move: 'Move to OU',
  accountExpiry: 'Account expiry',
  mustChangePassword: 'Must change password',
  clearPasswordNeverExpires: 'Password expires',
};

/** What a note in the preview says about the users it lists. */
export function noteText(kind: BulkAccountNote, n: number): string {
  switch (kind) {
    case 'never_expires':
      return `${users(n)} ${plural(n, 'has a password', 'have passwords')} that never ${plural(n, 'expires', 'expire')}. AD doesn’t ask for a change while that’s set, so clear “password never expires” for them too.`;
    case 'random_password':
      return `${users(n)} ${plural(n, 'was', 'were')} created with a random password nobody saw, and ${plural(n, 'signs', 'sign')} in through Entra. Must-change stops a synced user signing in to Entra unless Connect Sync’s force-change option is on.`;
    case 'must_change':
      return `${users(n)} already ${plural(n, 'has', 'have')} to change ${plural(n, 'their password', 'their passwords')}, which AD holds back while it never expires. They’ll be asked at their next sign-in.`;
  }
}

/** "2 will be moved · 1 is already in Leavers" */
export function previewSummary(preview: BulkAccountPreview, change: BulkAccountChange): string {
  const n = preview.changed.count;
  const u = preview.unchanged.count;
  const head =
    change.op === 'move'
      ? `${n} will be moved`
      : change.op === 'accountExpiry'
        ? `${n} will change`
        : change.op === 'mustChangePassword'
          ? `${n} will have to change their password`
          : `${n} will have ${plural(n, 'a password', 'passwords')} that ${plural(n, 'expires', 'expire')}`;
  const already =
    change.op === 'move'
      ? `${u} ${plural(u, 'is', 'are')} already in ${preview.ou?.name ?? 'it'}`
      : change.op === 'accountExpiry'
        ? change.expiresAt === null
          ? `${u} already never ${plural(u, 'expires', 'expire')}`
          : `${u} already ${plural(u, 'expires', 'expire')} then`
        : change.op === 'mustChangePassword'
          ? `${u} already ${plural(u, 'has', 'have')} to`
          : `${u} already ${plural(u, 'does', 'do')}`;
  return `${head} · ${already}`;
}

/** What the change does to the users it changes, said before confirming. */
export function consequence(change: BulkAccountChange): string {
  switch (change.op) {
    case 'move':
      return 'Their names, group memberships and GUIDs stay the same. Group Policy and permissions delegated on the OU apply to them from now on.';
    case 'accountExpiry':
      return change.expiresAt === null
        ? 'Their accounts won’t expire.'
        : `They can sign in until ${expiryMoment(change.expiresAt)}.`;
    case 'mustChangePassword':
      return 'They’re asked for a new password the next time they sign in.';
    case 'clearPasswordNeverExpires':
      return 'Their passwords expire as the password policy says; one already older than its maximum age has to be changed at the next sign-in.';
  }
}

/** What a user has now, as the preview lists it beside their name. */
export function fromText(op: BulkAccountOp, user: BulkAccountPreviewUser): string | null {
  if (op === 'move') return user.from ? `in ${user.from}` : null;
  if (op === 'accountExpiry') return `now ${expiryText(user.from)}`;
  return null;
}

export function useBulkAccountChange(options: {
  /** The selected users, read when the preview is asked for. */
  ids: () => string[];
  /** Start the job on what was previewed; useBulkActions prompts step-up first. */
  start: (change: BulkAccountRequest) => void;
  /** The changes the operator may make. */
  allowed: () => BulkAccountOp[];
}) {
  const visible = ref(false);
  const op = ref<BulkAccountOp>('move');

  const ous = ref<DirectoryOu[]>([]);
  const ousLoading = ref(false);
  const ousError = ref<string | null>(null);
  const ouLoads = latestRequest();
  const destination = ref<string | null>(null);

  const never = ref(false);
  const endOf = ref<Date | null>(null);

  const preview = shallowRef<BulkAccountPreview | null>(null);
  // What the preview was asked for, which the job then runs on.
  let previewed: { ids: string[]; change: BulkAccountChange } | null = null;
  const previewing = ref(false);
  const previewError = ref<string | null>(null);
  const previews = latestRequest();
  const loadingMore = ref(false);

  const count = computed(() => options.ids().length);
  /** The account settings offered beside the one chosen; a move is offered on its own. */
  const choices = computed<BulkAccountOp[]>(() =>
    op.value === 'move' ? [] : options.allowed().filter((o) => o !== 'move'),
  );

  const change = computed<BulkAccountChange | null>(() => {
    switch (op.value) {
      case 'move':
        return destination.value ? { op: 'move', targetOuDn: destination.value } : null;
      case 'accountExpiry': {
        if (never.value) return { op: 'accountExpiry', expiresAt: null };
        if (!endOf.value) return null;
        const expiresAt = expiryAtEndOf(endOf.value);
        return Date.parse(expiresAt) > Date.now() ? { op: 'accountExpiry', expiresAt } : null;
      }
      default:
        return { op: op.value };
    }
  });
  const canPreview = computed(() => count.value > 0 && change.value !== null && !previewing.value);
  const canConfirm = computed(() => (preview.value?.changed.count ?? 0) > 0);
  const hasMore = computed(
    () => !!preview.value && preview.value.changed.users.length < preview.value.changed.count,
  );
  const summary = computed(() =>
    preview.value && previewed ? previewSummary(preview.value, previewed.change) : null,
  );
  const notes = computed(() =>
    (preview.value?.notes ?? []).map((n) => ({ ...n, text: noteText(n.kind, n.count) })),
  );
  const effect = computed(() => (previewed ? consequence(previewed.change) : null));

  const title = computed(() => {
    const who = accounts(count.value);
    const ask = preview.value ? '?' : '';
    const ou = preview.value?.ou;
    const titles: Record<BulkAccountOp, string> = {
      move: ou ? `Move ${who} to ${ou.name}?` : `Move ${who} to an OU`,
      accountExpiry: `Set when ${who} expire${ask}`,
      mustChangePassword: `Make ${who} change their password${ask}`,
      clearPasswordNeverExpires: `Clear “password never expires” for ${who}${ask}`,
    };
    return titles[op.value];
  });
  const confirmLabel = computed(() => {
    const n = preview.value?.changed.count ?? 0;
    const who = n === 1 ? 'account' : accounts(n);
    const labels: Record<BulkAccountOp, string> = {
      move: `Move ${who}`,
      accountExpiry: `Set expiry of ${who}`,
      mustChangePassword: `Require change for ${who}`,
      clearPasswordNeverExpires: `Clear for ${who}`,
    };
    return labels[op.value];
  });

  function forgetPreview(): void {
    previews.begin();
    preview.value = null;
    previewed = null;
    previewing.value = false;
    loadingMore.value = false;
    previewError.value = null;
  }

  async function loadOus(): Promise<void> {
    const isCurrent = ouLoads.begin();
    ousLoading.value = true;
    ousError.value = null;
    try {
      const { ous: list } = await api.ous.list();
      if (isCurrent()) ous.value = list;
    } catch (err) {
      if (isCurrent()) ousError.value = message(err);
    } finally {
      if (isCurrent()) ousLoading.value = false;
    }
  }

  /** Open on a change: a move, or one of the account settings. */
  function open(initial: BulkAccountOp): void {
    op.value = initial;
    destination.value = null;
    never.value = false;
    endOf.value = null;
    forgetPreview();
    visible.value = true;
    if (initial === 'move' && ous.value.length === 0) void loadOus();
  }

  function close(): void {
    visible.value = false;
    forgetPreview();
  }

  /** Switch between the account settings; asks again what it'd change. */
  function setOp(next: BulkAccountOp): void {
    if (next === op.value || !choices.value.includes(next)) return;
    op.value = next;
    forgetPreview();
  }

  function setDestination(dn: string | null): void {
    destination.value = dn;
    forgetPreview();
  }

  /** Expire at the end of `day`. */
  function setEndOf(day: Date): void {
    endOf.value = day;
    never.value = false;
    forgetPreview();
  }

  /** Never expire, or (false) at the end of the day picked. */
  function setNever(value: boolean): void {
    never.value = value;
    forgetPreview();
  }

  async function review(): Promise<void> {
    const asked = change.value;
    if (!canPreview.value || !asked) return;
    const isCurrent = previews.begin();
    previewing.value = true;
    previewError.value = null;
    const request = { ids: options.ids(), change: asked };
    try {
      const result = await api.users.previewAccountChange(request);
      if (isCurrent()) {
        preview.value = result;
        previewed = request;
      }
    } catch (err) {
      if (isCurrent()) previewError.value = message(err);
    } finally {
      if (isCurrent()) previewing.value = false;
    }
  }

  /** The next page of the users it changes, added to the preview's list. */
  async function showMore(): Promise<void> {
    const shown = preview.value;
    if (!shown || !previewed || !hasMore.value || loadingMore.value) return;
    const isCurrent = previews.begin();
    loadingMore.value = true;
    try {
      const next = await api.users.previewAccountChange({
        ...previewed,
        offset: shown.changed.users.length,
      });
      if (!isCurrent()) return;
      if (next.previewToken !== shown.previewToken) {
        forgetPreview();
        previewError.value = 'The users changed since the preview. Preview it again.';
        return;
      }
      preview.value = {
        ...next,
        changed: { ...next.changed, users: [...shown.changed.users, ...next.changed.users] },
      };
    } catch (err) {
      if (isCurrent()) previewError.value = message(err);
    } finally {
      if (isCurrent()) loadingMore.value = false;
    }
  }

  /** Back from the preview to change what it does. */
  function back(): void {
    forgetPreview();
  }

  function confirm(): void {
    const shown = preview.value;
    if (!shown || !previewed || !canConfirm.value) return;
    const { ids, change: asked } = previewed;
    const now = new Set(options.ids());
    if (now.size !== ids.length || ids.some((id) => !now.has(id))) {
      forgetPreview();
      previewError.value = 'The selection changed since the preview. Preview it again.';
      return;
    }
    close();
    options.start({ ids, change: asked, previewToken: shown.previewToken });
  }

  return {
    visible,
    op,
    choices,
    count,
    title,
    confirmLabel,
    ous,
    ousLoading,
    ousError,
    destination,
    never,
    endOf,
    change,
    canPreview,
    preview,
    previewing,
    previewError,
    summary,
    notes,
    effect,
    canConfirm,
    hasMore,
    loadingMore,
    showMore,
    open,
    close,
    setOp,
    setDestination,
    setEndOf,
    setNever,
    review,
    back,
    confirm,
  };
}
