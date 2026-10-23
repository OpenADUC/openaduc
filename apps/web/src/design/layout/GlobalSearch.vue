<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import type { Capability, DirectoryOu, UserSummary } from '@openaduc/shared';
import {
  useDirectorySearch,
  type SearchKind,
  type SearchResults,
} from '../composables/useDirectorySearch.js';
import { useAccountActions } from '../composables/useAccountActions.js';
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
import {
  QUICK_ACTIONS,
  parseQuickQuery,
  quickActionsFor,
  quickVerbs,
  type QuickAction,
} from '../lib/quickActions.js';
import { useAuthStore } from '../../stores/auth.js';

interface ResultRow {
  kind: SearchKind;
  id: string;
  primary: string;
  secondary: string | null;
  to: RouteLocationRaw;
  user?: UserSummary;
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
const highlight = ref(0);

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
  rows: (found: SearchResults) => ResultRow[];
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
const verbs = computed(() => quickVerbs(can));

const results = computed(() => KINDS.flatMap((k) => k.rows(finder.results.value)));
const failed = computed(() =>
  KINDS.filter((k) => finder.failed.value.includes(k.kind)).map((k) => k.label),
);

const rowKey = (row: ResultRow) => `${row.kind}-${row.id}`;
// A refresh after an action keeps the highlight on the row acted on.
let keepHighlightOn: string | null = null;
watch(results, (next) => {
  const at = keepHighlightOn ? next.findIndex((r) => rowKey(r) === keepHighlightOn) : -1;
  keepHighlightOn = null;
  highlight.value = Math.max(at, 0);
});

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function runSearch(): Promise<void> {
  const { action, text } = parsed.value;
  if (text.length < 2) {
    finder.clear();
    return Promise.resolve();
  }
  return finder.search(text, action ? ['user'] : undefined);
}

watch(query, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runSearch(), 200);
});

// ---- Actions on users ------------------------------------------------------

// The highlighted user's actions; null until the operator moves into them,
// except that a query starting with a verb selects its action.
const actionAt = ref<number | null>(null);

function actionsOn(row: ResultRow): QuickAction[] {
  if (!row.user) return [];
  const offered = quickActionsFor(row.user, can);
  const only = parsed.value.action;
  return only ? offered.filter((a) => a === only) : offered;
}

const highlighted = computed(() => results.value[highlight.value] ?? null);
const highlightedActions = computed(() => (highlighted.value ? actionsOn(highlighted.value) : []));
const selectedAction = computed(() =>
  actionAt.value === null ? null : (highlightedActions.value[actionAt.value] ?? null),
);

watch([highlight, results], () => {
  actionAt.value = parsed.value.action && highlightedActions.value.length > 0 ? 0 : null;
});

function stepAction(by: 1 | -1): void {
  const at = actionAt.value;
  if (by > 0) {
    actionAt.value = at === null ? 0 : Math.min(at + 1, highlightedActions.value.length - 1);
  } else {
    actionAt.value = at === null || at === 0 ? null : at - 1;
  }
}

function showsActions(row: ResultRow): boolean {
  return !!parsed.value.action || isHighlighted(row);
}

// Why a user found by a verb isn't offered it, e.g. Unlock for an account
// that isn't locked.
function notFitting(row: ResultRow): string | null {
  const only = parsed.value.action;
  if (!row.user || !only || actionsOn(row).length > 0) return null;
  return QUICK_ACTIONS[only].notFitting;
}

// Reads the results again so they show what the action changed.
async function refresh(): Promise<void> {
  if (!open.value) return;
  keepHighlightOn = highlighted.value ? rowKey(highlighted.value) : null;
  await runSearch();
}

// The same workflow as the user's page: step-up first, the same calls and
// audit events, and Undo on the toast. A failure stays at the top of the
// panel, whatever the query has become since, until retried or dismissed.
const accountActions = useAccountActions<UserSummary>({
  onDone: async (action, u, offer) => {
    toast.add({ ...accountActionToast(action, u, offer), group: TOAST_GROUP });
    await refresh();
  },
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
  void refresh();
}

watch(resetOpen, (isOpen) => {
  if (!isOpen && open.value) focusInput();
});

function act(action: QuickAction, u: UserSummary): void {
  if (action === 'reset-password') {
    resetTarget.value = u;
    resetOpen.value = true;
  } else {
    accountActions.run(action, u);
  }
}

function runningLabel(action: QuickAction, u: UserSummary): string {
  const info = QUICK_ACTIONS[action];
  return (accountActions.runningOn(u.id) === action && info.running) || info.label;
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
  finder.reset();
  open.value = false;
  query.value = '';
  highlight.value = 0;
  actionAt.value = null;
}

function pick(row: ResultRow): void {
  close();
  void router.push(row.to);
}

function caretAtEnd(e: KeyboardEvent): boolean {
  const input = e.target as HTMLInputElement;
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

// → and ← (or Tab and Shift+Tab) move through the highlighted user's
// actions, → only from the end of the text so it can still move the caret.
// Esc leaves the actions before it closes the panel.
function onKeydown(e: KeyboardEvent): void {
  const hasActions = highlightedActions.value.length > 0;
  switch (e.key) {
    case 'Escape':
      if (actionAt.value !== null && !parsed.value.action) actionAt.value = null;
      else close();
      return;
    case 'ArrowDown':
      e.preventDefault();
      highlight.value = Math.min(highlight.value + 1, results.value.length - 1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      highlight.value = Math.max(highlight.value - 1, 0);
      return;
    case 'ArrowRight':
      if (!hasActions || !caretAtEnd(e)) return;
      e.preventDefault();
      stepAction(1);
      return;
    case 'ArrowLeft':
      if (actionAt.value === null) return;
      e.preventDefault();
      stepAction(-1);
      return;
    case 'Tab':
      if (!hasActions) return;
      e.preventDefault();
      stepAction(e.shiftKey ? -1 : 1);
      return;
    case 'Enter': {
      e.preventDefault();
      const row = highlighted.value;
      const action = selectedAction.value;
      if (row?.user && action) act(action, row.user);
      else if (row) pick(row);
    }
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
  return results.value.indexOf(row) === highlight.value;
}
</script>

<template>
  <div class="gs-wrap">
    <button type="button" class="gs-trigger" :title="'Search (Ctrl+K)'" @click="openSearch">
      <i class="pi pi-search" />
      <span class="gs-trigger-label">Search the directory…</span>
      <i
        v-if="actionFailure"
        class="pi pi-exclamation-circle gs-trigger-failed"
        title="An action from quick search failed"
      />
      <span class="gs-trigger-kbd kbd">⌘K</span>
    </button>

    <Teleport to="body">
      <div v-if="open" class="gs-overlay" @click.self="close">
        <div class="gs-panel" role="dialog" aria-modal="true" aria-label="Global search">
          <div class="gs-input-row">
            <i class="pi pi-search gs-input-icon" />
            <input
              ref="inputRef"
              v-model="query"
              type="search"
              class="gs-input"
              placeholder="Search the directory…"
              autocomplete="off"
              spellcheck="false"
              @keydown="onKeydown"
            />
            <span v-if="parsed.action" class="gs-verb">{{
              QUICK_ACTIONS[parsed.action].verb
            }}</span>
            <button type="button" class="gs-close" title="Close (Esc)" @click="close">
              <i class="pi pi-times" />
            </button>
          </div>

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
            <div v-if="loading && results.length === 0" class="gs-empty">Searching…</div>
            <div v-else-if="parsed.action && !parsed.text" class="gs-empty">
              {{ QUICK_ACTIONS[parsed.action].ask }}
            </div>
            <div
              v-else-if="
                !loading && parsed.text.length >= 2 && results.length === 0 && failed.length === 0
              "
              class="gs-empty"
            >
              {{ parsed.action ? 'No users match' : 'No matches for' }} "{{ parsed.text }}"
            </div>
            <div v-else-if="parsed.text.length < 2" class="gs-empty">
              Type at least 2 characters to search.
              <template v-if="!parsed.action && verbs.length > 0">
                <br />
                Start with {{ verbs.slice(0, -1).join(', ') }}{{ verbs.length > 1 ? ' or ' : ''
                }}{{ verbs.at(-1) }} to act on a user.
              </template>
            </div>

            <template v-else>
              <div
                v-for="g in groupedResults"
                :key="g.kind"
                class="gs-group"
                role="group"
                :aria-label="g.label"
              >
                <div class="gs-group-label">{{ g.label }}</div>
                <div
                  v-for="row in g.rows"
                  :key="rowKey(row)"
                  class="gs-row"
                  role="option"
                  :aria-selected="isHighlighted(row)"
                  :class="{ active: isHighlighted(row) }"
                  @mouseenter="highlight = results.indexOf(row)"
                  @click="pick(row)"
                >
                  <span v-if="g.icon" class="gs-row-icon"><i :class="['pi', g.icon]" /></span>
                  <Avatar v-else :name="row.primary" :seed="row.id" :size="28" />
                  <div class="gs-row-meta">
                    <div class="gs-row-primary">{{ row.primary }}</div>
                    <div v-if="row.secondary" class="gs-row-secondary">{{ row.secondary }}</div>
                  </div>
                  <span v-if="notFitting(row)" class="gs-row-note">{{ notFitting(row) }}</span>
                  <div
                    v-if="row.user && showsActions(row) && actionsOn(row).length > 0"
                    class="gs-actions"
                  >
                    <button
                      v-for="a in actionsOn(row)"
                      :key="a"
                      type="button"
                      tabindex="-1"
                      class="gs-action"
                      :class="{ selected: isHighlighted(row) && selectedAction === a }"
                      :disabled="accountActions.runningOn(row.user.id) !== null"
                      @click.stop="act(a, row.user)"
                    >
                      <i
                        :class="[
                          'pi',
                          accountActions.runningOn(row.user.id) === a
                            ? 'pi-spin pi-spinner'
                            : QUICK_ACTIONS[a].icon,
                        ]"
                      />{{ runningLabel(a, row.user) }}
                    </button>
                  </div>
                  <i v-else class="pi pi-arrow-right gs-row-go" />
                </div>
              </div>
            </template>
          </div>

          <footer class="gs-foot">
            <span><span class="kbd">↑↓</span> navigate</span>
            <span v-if="highlightedActions.length > 0 && actionAt === null">
              <span class="kbd">→</span> / <span class="kbd">tab</span> actions
            </span>
            <span v-else-if="highlightedActions.length > 1">
              <span class="kbd">←→</span> choose
            </span>
            <span>
              <span class="kbd">↵</span>
              {{ selectedAction ? QUICK_ACTIONS[selectedAction].verb : 'open' }}
            </span>
            <span>
              <span class="kbd">esc</span>
              {{ actionAt !== null && !parsed.action ? 'back' : 'close' }}
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

.gs-action:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.gs-action.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.gs-action:disabled {
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
