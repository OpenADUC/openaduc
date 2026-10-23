<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import type { Capability, DirectoryOu, UserSummary } from '@openaduc/shared';
import {
  useDirectorySearch,
  type SearchKind,
  type SearchResults,
} from '../composables/useDirectorySearch.js';
import { useAccountActions } from '../composables/useAccountActions.js';
import { useResultKeys } from '../composables/useResultKeys.js';
import type { ResetOutcome } from '../composables/usePasswordReset.js';
import AppToast from '../feedback/AppToast.vue';
import InlineFailure from '../feedback/InlineFailure.vue';
import ResetPasswordDialog from '../feedback/ResetPasswordDialog.vue';
import {
  accountActionFailedSummary,
  accountActionToast,
  passwordResetToast,
} from '../feedback/userToasts.js';
import Avatar from '../primitives/Avatar.vue';
import { dnPath, rdns } from '../lib/dn.js';
import { nameOf } from '../lib/format.js';
import {
  QUICK_ACTIONS,
  parseQuickQuery,
  quickActionsFor,
  quickVerbs,
} from '../lib/quickActions.js';
import { USER_ACTIONS, userActionLabel, type UserAction } from '../lib/userActions.js';
import { useAuthStore } from '../../stores/auth.js';

interface FoundRow {
  kind: SearchKind;
  id: string;
  primary: string;
  secondary: string | null;
  to: RouteLocationRaw;
  user?: UserSummary;
}

interface ResultRow extends FoundRow {
  key: string;
  actions: UserAction[];
}

const PER_KIND = 6;
// Its own toasts, as not every page mounts one.
const TOAST_GROUP = 'quick-search';

const router = useRouter();
const auth = useAuthStore();
const toast = useToast();
const finder = useDirectorySearch({ pageSize: PER_KIND });
const { loading } = finder;
const can = (capability: Capability) => auth.hasCapability(capability);

const open = ref(false);
const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const resultsRef = ref<HTMLElement | null>(null);
const uid = useId();

// Where an OU sits, for its result row: OU=Sales,OU=Corp,DC=corp,DC=example
// reads "corp.example / Corp".
function ouPath(ou: DirectoryOu): string {
  return dnPath(rdns(ou.distinguishedName).slice(1), ' / ');
}

// Display order of the result groups; arrow keys walk them in this order.
const KINDS: {
  kind: SearchKind;
  label: string;
  icon?: string;
  rows: (found: SearchResults) => FoundRow[];
}[] = [
  {
    kind: 'user',
    label: 'Users',
    rows: (found) =>
      found.user.map((u) => ({
        kind: 'user',
        id: u.id,
        primary: u.displayName ?? u.samAccountName,
        secondary: u.email ?? u.userPrincipalName ?? u.title ?? null,
        to: `/users/${u.id}`,
        user: u,
      })),
  },
  {
    kind: 'group',
    label: 'Groups',
    icon: 'pi-objects-column',
    rows: (found) =>
      found.group.map((g) => ({
        kind: 'group',
        id: g.id,
        primary: g.name ?? g.samAccountName ?? '(unnamed group)',
        secondary: g.description ?? `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
        to: `/groups/${g.id}`,
      })),
  },
  {
    kind: 'computer',
    label: 'Computers',
    icon: 'pi-desktop',
    rows: (found) =>
      found.computer.map((c) => ({
        kind: 'computer',
        id: c.id,
        primary: c.name ?? c.samAccountName ?? '(unnamed computer)',
        secondary: c.dnsHostName ?? c.operatingSystem ?? null,
        to: `/computers/${c.id}`,
      })),
  },
  {
    kind: 'ou',
    label: 'OUs',
    icon: 'pi-folder',
    rows: (found) =>
      found.ou.map((ou) => ({
        kind: 'ou',
        id: ou.distinguishedName,
        primary: ou.name,
        secondary: ouPath(ou) || null,
        to: { path: '/browse', query: { ou: ou.distinguishedName } },
      })),
  },
];

// "unlock jdoe" searches users for "jdoe" and offers to unlock them.
const parsed = computed(() => parseQuickQuery(query.value, can));
const verb = computed(() => parsed.value.action);
const verbs = computed(() => quickVerbs(can));

const userKey = (id: string) => `user-${id}`;

function actionsFor(u: UserSummary): UserAction[] {
  const offered = quickActionsFor(u, can);
  const only = verb.value;
  return only ? offered.filter((a) => a === only) : offered;
}

const results = computed<ResultRow[]>(() =>
  KINDS.flatMap((k) => k.rows(finder.results.value)).map((r) => ({
    ...r,
    key: `${r.kind}-${r.id}`,
    actions: r.user ? actionsFor(r.user) : [],
  })),
);
const failed = computed(() =>
  KINDS.filter((k) => finder.failed.value.includes(k.kind)).map((k) => k.label),
);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const debouncing = ref(false);

function runSearch(): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer);
  debouncing.value = false;
  const { action, text } = parsed.value;
  if (text.length < 2) {
    finder.clear();
    return Promise.resolve();
  }
  return finder.search(text, action ? ['user'] : undefined);
}

watch(query, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debouncing.value = true;
  debounceTimer = setTimeout(() => void runSearch(), 200);
});

// Whether the results answer the text in the box, so Enter can't act on
// the top match of what was typed before.
function ready(): boolean {
  const { text } = parsed.value;
  return (
    !debouncing.value && !loading.value && finder.answers.value === (text.length >= 2 ? text : null)
  );
}

const keys = useResultKeys<UserAction, ResultRow>({
  rows: results,
  preselect: () => verb.value !== null,
  ready,
});
const { highlight, actionAt, highlighted, selectedAction } = keys;

// Said when Enter came before the results did; gone once they land.
const waitNotice = ref<string | null>(null);
watch(results, () => (waitNotice.value = null));

function showsActions(row: ResultRow): boolean {
  return verb.value !== null || isHighlighted(row);
}

// Why a user found by a verb isn't offered it, e.g. Unlock for an account
// that isn't locked.
function notFitting(row: ResultRow): string | null {
  const only = verb.value;
  if (!row.user || !only || row.actions.length > 0) return null;
  return QUICK_ACTIONS[only].notFitting;
}

async function refreshOn(id: string): Promise<void> {
  if (!open.value) return;
  keys.keepHighlightOn(userKey(id));
  await runSearch();
}

// The same workflow as the user's page: step-up first, the same calls and
// audit events, and Undo on the toast. A failure stays at the top of the
// panel, whatever the query has become since, until retried or dismissed.
const accountActions = useAccountActions<UserSummary>({
  onDone: async (action, u, offer) => {
    toast.add({ ...accountActionToast(action, u, offer), group: TOAST_GROUP });
    await refreshOn(u.id);
  },
});

const lastRun = shallowRef<{ action: UserAction; user: UserSummary } | null>(null);
const running = computed(() => {
  const run = lastRun.value;
  return run && accountActions.runningOn(run.user.id) === run.action ? run : null;
});

const actionFailure = computed(() => {
  const f = accountActions.failure.value;
  if (!f) return null;
  return {
    summary: accountActionFailedSummary(f.op.action, f.op.account),
    message: f.message,
    busy: accountActions.runningOn(f.op.account.id) !== null,
  };
});

const resetTarget = ref<UserSummary | null>(null);
const resetOpen = ref(false);

function onPasswordReset(outcome: ResetOutcome): void {
  toast.add({ ...passwordResetToast(outcome), group: TOAST_GROUP });
  if (resetTarget.value) void refreshOn(resetTarget.value.id);
}

watch(resetOpen, (isOpen) => {
  if (!isOpen && open.value) focusInput();
});

function act(action: UserAction, u: UserSummary): void {
  if (action === 'reset-password') {
    resetTarget.value = u;
    resetOpen.value = true;
    return;
  }
  if (accountActions.runningOn(u.id) !== null) return;
  lastRun.value = { action, user: u };
  accountActions.run(action, u);
}

function actionLabel(action: UserAction, u: UserSummary): string {
  return userActionLabel(action, accountActions.runningOn(u.id));
}

function focusInput(): void {
  void nextTick(() => inputRef.value?.focus());
}

function openSearch(): void {
  open.value = true;
  focusInput();
}

function close(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debouncing.value = false;
  finder.reset();
  open.value = false;
  query.value = '';
  waitNotice.value = null;
  keys.reset();
}

function pick(row: ResultRow): void {
  close();
  void router.push(row.to);
}

function caretAtEnd(input: HTMLInputElement): boolean {
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

function onKeydown(e: KeyboardEvent): void {
  const intent = keys.keydown(e, caretAtEnd(e.target as HTMLInputElement));
  switch (intent?.kind) {
    case 'close':
      close();
      break;
    case 'open':
      pick(intent.row);
      break;
    case 'run':
      if (intent.row.user) act(intent.action, intent.row.user);
      break;
    case 'wait':
      if (debouncing.value) void runSearch();
      waitNotice.value = `Still searching for “${parsed.value.text}”. Press Enter again once the results show.`;
      break;
  }
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (open.value) close();
    else openSearch();
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));

const groupedResults = computed(() =>
  KINDS.map((k) => ({ ...k, rows: results.value.filter((r) => r.kind === k.kind) })).filter(
    (g) => g.rows.length > 0,
  ),
);

// Keep the keyboard highlight visible as it moves down a long list.
watch(highlight, () =>
  nextTick(() =>
    resultsRef.value?.querySelector('.gs-row.active')?.scrollIntoView?.({ block: 'nearest' }),
  ),
);

function isHighlighted(row: ResultRow): boolean {
  return highlighted.value === row;
}

const listboxId = `${uid}-results`;
const optionId = (row: ResultRow) => `${uid}-${results.value.indexOf(row)}`;
const actionId = (row: ResultRow, action: UserAction) => `${optionId(row)}-${action}`;

const activeDescendant = computed(() => {
  const row = highlighted.value;
  if (!row) return undefined;
  const action = selectedAction.value;
  return action ? actionId(row, action) : optionId(row);
});

const TYPE_MORE = 'Type at least 2 characters to search.';

const emptyText = computed(() => {
  const { action, text } = parsed.value;
  if (loading.value && results.value.length === 0) return 'Searching…';
  if (action && !text) return QUICK_ACTIONS[action].ask;
  if (!loading.value && text.length >= 2 && results.value.length === 0 && failed.value.length === 0)
    return `${action ? 'No users match' : 'No matches for'} "${text}"`;
  if (text.length < 2) return TYPE_MORE;
  return null;
});

const verbHelp = computed(() => {
  const v = verbs.value;
  if (parsed.value.action || v.length === 0) return null;
  const list = v.length > 1 ? `${v.slice(0, -1).join(', ')} or ${v.at(-1)}` : v[0];
  return `Start with ${list} to act on a user. Start with " to search for those words as written.`;
});

// Read out politely, as focus never leaves the search box.
const announcement = computed(() => {
  if (waitNotice.value) return waitNotice.value;
  const run = running.value;
  if (run) return `${USER_ACTIONS[run.action].running} ${nameOf(run.user)}`;
  if (emptyText.value && emptyText.value !== TYPE_MORE) return emptyText.value;
  const row = highlighted.value;
  const action = selectedAction.value;
  if (row && action) return `${USER_ACTIONS[action].label}, ${row.primary}. Press Enter.`;
  return '';
});
</script>

<template>
  <div class="gs-wrap">
    <button
      type="button"
      class="gs-trigger"
      :title="'Search (Ctrl+K)'"
      :aria-label="
        actionFailure
          ? 'Search the directory. An action from quick search failed.'
          : 'Search the directory'
      "
      @click="openSearch"
    >
      <i class="pi pi-search" aria-hidden="true" />
      <span class="gs-trigger-label">Search the directory…</span>
      <i
        v-if="actionFailure"
        class="pi pi-exclamation-circle gs-trigger-failed"
        aria-hidden="true"
        title="An action from quick search failed"
      />
      <span class="gs-trigger-kbd kbd" aria-hidden="true">⌘K</span>
    </button>

    <Teleport to="body">
      <div v-if="open" class="gs-overlay" @click.self="close">
        <div class="gs-panel" role="dialog" aria-modal="true" aria-label="Global search">
          <div class="gs-input-row">
            <i class="pi pi-search gs-input-icon" aria-hidden="true" />
            <input
              ref="inputRef"
              v-model="query"
              type="search"
              class="gs-input"
              placeholder="Search the directory…"
              autocomplete="off"
              spellcheck="false"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="results.length > 0"
              :aria-controls="listboxId"
              :aria-activedescendant="activeDescendant"
              @keydown="onKeydown"
            />
            <span v-if="verb" class="gs-verb">{{ QUICK_ACTIONS[verb].verb }}</span>
            <button type="button" class="gs-close" title="Close (Esc)" @click="close">
              <i class="pi pi-times" />
            </button>
          </div>

          <div class="sr-only" role="status" aria-live="polite">{{ announcement }}</div>

          <div ref="resultsRef" class="gs-results">
            <div v-if="actionFailure" class="gs-failure">
              <InlineFailure
                :summary="actionFailure.summary"
                :message="actionFailure.message"
                :busy="actionFailure.busy"
                @retry="accountActions.retry"
                @dismiss="accountActions.dismiss"
              />
            </div>
            <div v-if="failed.length > 0 && !loading" class="gs-failed" role="status">
              <i class="pi pi-exclamation-triangle" />
              Couldn't search {{ failed.join(' or ') }}.
            </div>
            <div v-if="waitNotice" class="gs-wait">{{ waitNotice }}</div>
            <div v-if="emptyText" class="gs-empty">
              {{ emptyText }}
              <template v-if="parsed.text.length < 2 && verbHelp">
                <br />
                {{ verbHelp }}
              </template>
            </div>

            <div v-show="!emptyText" :id="listboxId" role="listbox" aria-label="Results">
              <div
                v-for="g in groupedResults"
                :key="g.kind"
                class="gs-group"
                role="group"
                :aria-label="g.label"
              >
                <div class="gs-group-label" aria-hidden="true">{{ g.label }}</div>
                <div
                  v-for="row in g.rows"
                  :key="row.key"
                  class="gs-row"
                  role="presentation"
                  :class="{ active: isHighlighted(row) }"
                  @mouseenter="keys.hover(results.indexOf(row))"
                  @mousedown.prevent
                  @click="pick(row)"
                >
                  <div
                    :id="optionId(row)"
                    class="gs-row-main"
                    role="option"
                    :aria-selected="isHighlighted(row) && actionAt === null"
                  >
                    <span v-if="g.icon" class="gs-row-icon"><i :class="['pi', g.icon]" /></span>
                    <Avatar v-else :name="row.primary" :seed="row.id" :size="28" />
                    <div class="gs-row-meta">
                      <div class="gs-row-primary">{{ row.primary }}</div>
                      <div v-if="row.secondary" class="gs-row-secondary">{{ row.secondary }}</div>
                    </div>
                  </div>
                  <span v-if="notFitting(row)" class="gs-row-note">{{ notFitting(row) }}</span>
                  <div
                    v-if="row.user && showsActions(row) && row.actions.length > 0"
                    class="gs-actions"
                    role="presentation"
                  >
                    <div
                      v-for="a in row.actions"
                      :id="actionId(row, a)"
                      :key="a"
                      class="gs-action"
                      role="option"
                      :aria-label="`${actionLabel(a, row.user)}, ${row.primary}`"
                      :aria-selected="isHighlighted(row) && selectedAction === a"
                      :aria-disabled="accountActions.runningOn(row.user.id) !== null"
                      :class="{
                        selected: isHighlighted(row) && selectedAction === a,
                        busy: accountActions.runningOn(row.user.id) !== null,
                      }"
                      @click.stop="act(a, row.user)"
                    >
                      <i
                        :class="[
                          'pi',
                          accountActions.runningOn(row.user.id) === a
                            ? 'pi-spin pi-spinner'
                            : USER_ACTIONS[a].icon,
                        ]"
                        aria-hidden="true"
                      />{{ actionLabel(a, row.user) }}
                    </div>
                  </div>
                  <i v-else class="pi pi-arrow-right gs-row-go" aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>

          <footer class="gs-foot" aria-hidden="true">
            <span><span class="kbd">↑↓</span> navigate</span>
            <span v-if="(highlighted?.actions.length ?? 0) > 0 && actionAt === null">
              <span class="kbd">→</span> / <span class="kbd">tab</span> actions
            </span>
            <span v-else-if="(highlighted?.actions.length ?? 0) > 1">
              <span class="kbd">←→</span> choose
            </span>
            <span>
              <span class="kbd">↵</span>
              {{ selectedAction ? QUICK_ACTIONS[selectedAction].verb : 'open' }}
            </span>
            <span>
              <span class="kbd">esc</span>
              {{ actionAt !== null && !verb ? 'back' : 'close' }}
            </span>
          </footer>
        </div>
      </div>
    </Teleport>

    <ResetPasswordDialog v-model:visible="resetOpen" :user="resetTarget" @reset="onPasswordReset" />
    <AppToast :group="TOAST_GROUP" />
  </div>
</template>

<style scoped>
.gs-wrap {
  flex: 1 1 120px;
  min-width: 0;
  display: flex;
  justify-content: flex-start;
}

.gs-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 480px;
  min-width: 0;
  padding: 6px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-3);
  font-size: 13px;
  cursor: pointer;
  font-family: var(--font-sans);
}

.gs-trigger:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}

.gs-trigger-label {
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-trigger-kbd {
  font-size: 10.5px;
  flex-shrink: 0;
}

.gs-trigger-failed {
  color: var(--red);
  flex-shrink: 0;
}

.gs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 80px 16px 16px;
  z-index: 1000;
}

.gs-panel {
  width: 100%;
  max-width: 640px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  max-height: min(560px, 80vh);
}

.gs-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.gs-input-icon {
  color: var(--text-3);
}

.gs-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--text);
  font-size: 15px;
  font-family: var(--font-sans);
}

.gs-verb {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 500;
}

.gs-close {
  background: transparent;
  border: 0;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.gs-close:hover {
  background: var(--hover);
  color: var(--text);
}

.gs-results {
  overflow: auto;
  flex: 1;
}

.gs-failure {
  margin: 8px 8px 0;
}

.gs-wait {
  margin: 8px 8px 0;
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--text-2);
}

.gs-failed {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 8px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 12.5px;
  color: var(--text-2);
}

.gs-empty {
  padding: 24px;
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
}

.gs-group {
  padding: 8px 8px 12px;
}

.gs-group-label {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 8px 12px 6px;
}

.gs-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  color: var(--text);
}

.gs-row.active {
  background: var(--hover);
}

.gs-row-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  border-radius: 50%;
  color: var(--text-2);
}

.gs-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.gs-row-meta {
  flex: 1;
  min-width: 0;
}

.gs-row-primary {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-row-secondary {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-row-go {
  color: var(--text-4);
  font-size: 11px;
}

.gs-row.active .gs-row-go {
  color: var(--accent-text);
}

.gs-row-note {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-3);
}

.gs-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.gs-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12px;
  font-family: var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
}

.gs-action:hover:not(.busy) {
  border-color: var(--border-strong);
  color: var(--text);
}

.gs-action.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.gs-action.busy {
  cursor: default;
  opacity: 0.7;
}

.gs-action .pi {
  font-size: 11px;
}

.gs-foot {
  border-top: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 10px 16px;
  font-size: 11.5px;
  color: var(--text-3);
}

@media (max-width: 767.98px) {
  .gs-trigger {
    padding: 6px 8px;
  }

  .gs-trigger-kbd {
    display: none;
  }

  .gs-overlay {
    padding: 0;
  }

  .gs-panel {
    max-height: 100vh;
    border-radius: 0;
    height: 100vh;
  }
}
</style>
