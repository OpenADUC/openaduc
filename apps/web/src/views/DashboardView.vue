<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import {
  api,
  type AuditEventRow,
  type DirectorySummary,
  type SyncTaskSummary,
} from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import Card from '../design/primitives/Card.vue';
import Avatar from '../design/primitives/Avatar.vue';
import StatusBadge from '../design/primitives/StatusBadge.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import AuditEventDialog from '../design/feedback/AuditEventDialog.vue';
import AppToast from '../design/feedback/AppToast.vue';
import InlineFailure from '../design/feedback/InlineFailure.vue';
import ResetPasswordDialog from '../design/feedback/ResetPasswordDialog.vue';
import AccountExpiryDialog from '../design/feedback/AccountExpiryDialog.vue';
import { undoable } from '../design/feedback/undoToast.js';
import {
  accountActionToast,
  expiryFailedSummary,
  expirySetSummary,
  passwordResetToast,
} from '../design/feedback/userToasts.js';
import { useAccountActions } from '../design/composables/useAccountActions.js';
import { useAccountExpiry } from '../design/composables/useAccountExpiry.js';
import { useAttentionQueue } from '../design/composables/useAttentionQueue.js';
import { useSignInFixes } from '../design/composables/useSignInFixes.js';
import type { ResetOutcome } from '../design/composables/usePasswordReset.js';
import type { ActionFailure } from '../design/lib/actionFailure.js';
import { fmtRelative, nameOf } from '../design/lib/format.js';
import { userStatus } from '../design/lib/signIn.js';
import type { UserSummary } from '@openaduc/shared';

const router = useRouter();
const auth = useAuthStore();
const toast = useToast();

// "Issues" window — only the most urgent accounts: locked, made to change
// their password, or with an account or password expired or expiring within
// the next 24h. The broader "expiring this fortnight" view lives on /users
// via the saved view.
const ISSUES_DAYS = 1;

// A row that left stays while something failed on it, such as an Undo.
const queue = useAttentionQueue({
  withinDays: ISSUES_DAYS,
  pageSize: 10,
  keep: (u) => failureOn(u) !== null,
});
// Set when the issues list couldn't load: show that, never "Nothing on fire".
const { rows: issueRows, total: issueTotal, error: issuesError, load: loadIssues } = queue;
const recentEvents = ref<AuditEventRow[]>([]);
const loading = ref(true);
const directory = ref<DirectorySummary | null>(null);
// Aggregate of the directory's per-task scheduler state. Null until the
// task list arrives. The full table lives on /tasks; this is just a roll-up.
const directoryTasks = ref<SyncTaskSummary[] | null>(null);

// Audit-event detail dialog — opens when an activity-feed row is clicked.
const detailEvent = ref<AuditEventRow | null>(null);
const detailOpen = ref(false);

const canConfigure = computed(() => auth.hasCapability('configure:directory'));
const canViewAudit = computed(() => auth.hasCapability('view:audit'));

const runningTaskCount = computed(
  () => directoryTasks.value?.filter((t) => t.lastStatus === 'running').length ?? 0,
);
const failingTaskCount = computed(
  () => directoryTasks.value?.filter((t) => t.consecutiveFailures > 0).length ?? 0,
);
const lastTaskActivity = computed<Date | null>(() => {
  const tasks = directoryTasks.value ?? [];
  let best: number | null = null;
  for (const t of tasks) {
    const ts = t.lastFinishedAt ? new Date(t.lastFinishedAt).getTime() : null;
    if (ts !== null && (best === null || ts > best)) best = ts;
  }
  return best === null ? null : new Date(best);
});
const firstFailingTask = computed(
  () => (directoryTasks.value ?? []).find((t) => t.consecutiveFailures > 0 && t.lastError) ?? null,
);

const syncTone = computed<'green' | 'red' | 'amber' | 'muted'>(() => {
  if (!directory.value) return 'muted';
  if (!directory.value.syncBindUpn || !directory.value.hasSyncBindPassword) return 'muted';
  if (runningTaskCount.value > 0) return 'amber';
  if (failingTaskCount.value > 0) return 'red';
  if ((directoryTasks.value?.length ?? 0) > 0) return 'green';
  return 'muted';
});

const syncStatusLabel = computed(() => {
  const d = directory.value;
  if (!d) return 'unknown';
  if (!d.syncBindUpn || !d.hasSyncBindPassword) return 'Service account not configured';
  if (runningTaskCount.value > 0) {
    return `${runningTaskCount.value} task${runningTaskCount.value === 1 ? '' : 's'} running`;
  }
  if (failingTaskCount.value > 0) {
    return `${failingTaskCount.value} task${failingTaskCount.value === 1 ? '' : 's'} failing`;
  }
  if ((directoryTasks.value?.length ?? 0) === 0) return 'Awaiting first scheduler tick';
  return 'All tasks healthy';
});

// Set when a panel couldn't load: show that and a retry, never an empty
// state that reads as "nothing happened" or "all fine".
const activityError = ref<string | null>(null);
const healthError = ref<string | null>(null);

async function loadActivity(): Promise<void> {
  if (!canViewAudit.value) return;
  activityError.value = null;
  try {
    const r = await api.audit.list({ pageSize: 8 });
    recentEvents.value = r.rows;
  } catch (err) {
    recentEvents.value = [];
    activityError.value = err instanceof Error ? err.message : 'Failed to load';
  }
}

async function loadDirectoryHealth(): Promise<void> {
  if (!canConfigure.value) return;
  healthError.value = null;
  try {
    const r = await api.directories.list();
    // The actor's session is bound to one directory at a time. Pick that
    // one out of the list rather than guessing — multi-directory deployments
    // would otherwise show whichever happens to be first.
    const sessionDirId = auth.actor?.directoryId ?? null;
    directory.value = r.directories.find((d) => d.id === sessionDirId) ?? r.directories[0] ?? null;
    if (directory.value && directory.value.syncBindUpn && directory.value.hasSyncBindPassword) {
      const tr = await api.directories.syncTasks.list(directory.value.id);
      directoryTasks.value = tr.tasks;
    } else {
      directoryTasks.value = [];
    }
  } catch (err) {
    healthError.value = err instanceof Error ? err.message : 'Failed to load';
  }
}

async function load(): Promise<void> {
  loading.value = true;
  await Promise.all([loadIssues(), loadActivity(), loadDirectoryHealth()]);
  loading.value = false;
}

function openUser(u: UserSummary): void {
  void router.push({ name: 'user-detail', params: { id: u.id } });
}

// Each row offers the fix its user's page leads with, made through the same
// workflow, so it prompts step-up and is audited the same way.

const accountActions = useAccountActions<UserSummary>({
  failuresPerAccount: true,
  onDone: async (action, u, offer) => {
    toast.add(accountActionToast(action, u, offer));
    await queue.reread(u.id);
  },
});

const resetTarget = ref<UserSummary | null>(null);
const resetOpen = ref(false);

// The reset asks for a change at next sign-in by default, which keeps the
// account on the list; the operator has dealt with it either way.
function onPasswordReset(outcome: ResetOutcome): void {
  toast.add(passwordResetToast(outcome));
  if (resetTarget.value) queue.handled(resetTarget.value.id);
}

const expiryOpen = ref(false);
const expiry = useAccountExpiry({
  failuresPerAccount: true,
  onSet: async (account, expiresAt, offer) => {
    toast.add(
      undoable(
        { severity: 'success', summary: expirySetSummary(account.name, expiresAt), life: 4000 },
        offer,
      ),
    );
    // An Undo (no offer) lands from its toast, maybe while the dialog is
    // open for another account.
    if (offer) expiryOpen.value = false;
    await queue.reread(account.id);
  },
});

// A failed expiry change shows in the dialog that made it while that's
// open, else (an Undo's failure) on its row.
const expiryDialogFailure = computed(() => {
  const id = expiry.account.value?.id;
  const f = expiryOpen.value && id ? expiry.failureOn(id) : null;
  return f && !f.undo ? f : null;
});

function closeExpiry(): void {
  expiryOpen.value = false;
  const f = expiryDialogFailure.value;
  if (f) expiry.dismissOn(f.op.account.id);
}

const fixes = useSignInFixes<UserSummary>({
  actions: accountActions,
  resetPassword: (u) => {
    resetTarget.value = u;
    resetOpen.value = true;
  },
  extendExpiry: (u) => {
    expiry.load({ id: u.id, name: nameOf(u), accountExpiresAt: u.accountExpiresAt });
    expiryOpen.value = true;
  },
  extendingExpiry: (u) => expiry.submitting.value && expiry.account.value?.id === u.id,
});

/** What failed on a row: a fix, an Undo, or reading the account back. */
function failureOn(u: UserSummary): ActionFailure | null {
  const action = fixes.actionFailureOn(u.id);
  if (action) return action;
  const exp = expiry.failureOn(u.id);
  if (exp && exp !== expiryDialogFailure.value) {
    return {
      summary: expiryFailedSummary(exp.op.account.name),
      message: exp.message,
      retry: () => expiry.retryOn(u.id),
      dismiss: () => expiry.dismissOn(u.id),
    };
  }
  const reread = queue.rereadFailureOn(u.id);
  if (reread) {
    return {
      summary: `Couldn’t read ${nameOf(u)} back`,
      message: reread,
      retry: () => void queue.reread(u.id),
      dismiss: () => queue.dismissRereadFailure(u.id),
    };
  }
  return null;
}

function openEventDetail(ev: AuditEventRow): void {
  detailEvent.value = ev;
  detailOpen.value = true;
}

// Tiny label per user explaining *why* they're in the issues list. Mirrors
// the StatusBadge logic but written for prose.
function issueReason(u: UserSummary): string {
  const status = userStatus(u);
  if (status === 'locked') return 'Locked out';
  if (status === 'disabled') return 'Disabled';
  if (status === 'expired') return 'Account expired';
  if (status === 'pwd-expired') return 'Password expired';
  if (status === 'pwd-must-change') return 'Must change password at next sign-in';
  if (status === 'pwd-expiring') {
    if (!u.passwordExpiresAt) return 'Password expiring soon';
    const days = Math.ceil(
      (new Date(u.passwordExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    if (days <= 0) return 'Password expired';
    if (days === 1) return 'Password expires tomorrow';
    return `Password expires in ${days}d`;
  }
  return 'Needs attention';
}

function eventTone(action: string, result: string): 'green' | 'red' | 'amber' | 'blue' | 'muted' {
  if (result === 'failure' || result === 'denied') return 'red';
  if (action.startsWith('auth.')) return 'blue';
  if (action.startsWith('user.')) return 'green';
  if (action.startsWith('sync.')) return 'amber';
  return 'muted';
}

function eventIcon(action: string): string {
  if (action.startsWith('auth.')) return 'pi pi-sign-in';
  if (action.includes('unlock')) return 'pi pi-unlock';
  if (action.includes('lock')) return 'pi pi-lock';
  if (action.includes('view')) return 'pi pi-eye';
  if (action.includes('search')) return 'pi pi-search';
  if (action.startsWith('sync.')) return 'pi pi-refresh';
  return 'pi pi-circle-fill';
}

onMounted(load);
</script>

<template>
  <AppToast />
  <div class="page-inner dashboard">
    <PageHeader title="Dashboard">
      <template #actions>
        <!-- Directory health rolled up into one pill; /tasks has the detail. -->
        <button
          v-if="canConfigure && healthError"
          type="button"
          class="dir-pill"
          :title="healthError"
          @click="loadDirectoryHealth"
        >
          <span class="dir-pill-dot dir-pill-dot-red" />
          <span class="dir-pill-label">Couldn't load directory status · Retry</span>
        </button>
        <button
          v-else-if="canConfigure && directory"
          type="button"
          class="dir-pill"
          :title="firstFailingTask?.lastError ?? syncStatusLabel"
          @click="router.push('/tasks')"
        >
          <span class="dir-pill-dot" :class="`dir-pill-dot-${syncTone}`" />
          <span class="dir-pill-label">{{ syncStatusLabel }}</span>
          <span v-if="lastTaskActivity" class="dir-pill-time mono">
            {{ fmtRelative(lastTaskActivity) }}
          </span>
        </button>
        <Button
          label="Browse users"
          icon="pi pi-users"
          severity="secondary"
          outlined
          @click="router.push('/users')"
        />
      </template>
    </PageHeader>

    <Card
      title="Accounts needing attention"
      :sub="
        issuesError
          ? 'unavailable'
          : issueTotal > 0
            ? `${issueTotal} total · locked, must change password, or account or password expiring within 24h`
            : 'all clear'
      "
    >
      <EmptyState
        v-if="issuesError"
        icon="pi pi-exclamation-triangle"
        title="Couldn't load accounts needing attention"
        :message="issuesError"
      >
        <template #actions>
          <Button label="Retry" icon="pi pi-refresh" size="small" @click="loadIssues" />
        </template>
      </EmptyState>
      <EmptyState
        v-else-if="!loading && issueRows.length === 0"
        icon="pi pi-check-circle"
        title="Nothing on fire"
        message="No enabled accounts are locked, must change their password, or have an account or password expiring in the next 24 hours."
      />
      <ul v-else class="user-list">
        <li v-for="u in issueRows" :key="u.id" class="user-list-item">
          <div class="user-list-row" @click="openUser(u)">
            <Avatar :name="nameOf(u)" :seed="u.samAccountName" />
            <div class="user-list-meta">
              <div class="user-list-name">{{ nameOf(u) }}</div>
              <div class="user-list-sub mono">{{ issueReason(u) }}</div>
            </div>
            <StatusBadge :user="u" />
            <Button
              v-if="fixes.fixOf(u)"
              class="user-list-fix"
              :label="fixes.fixOf(u)!.label"
              :icon="`pi ${fixes.fixOf(u)!.icon}`"
              size="small"
              severity="secondary"
              outlined
              :loading="fixes.running(fixes.fixOf(u)!, u)"
              @click.stop="fixes.run(fixes.fixOf(u)!, u)"
            />
          </div>
          <InlineFailure
            v-if="failureOn(u)"
            class="user-list-failure"
            :summary="failureOn(u)!.summary"
            :message="failureOn(u)!.message"
            :busy="accountActions.runningOn(u.id) !== null"
            @retry="failureOn(u)!.retry"
            @dismiss="failureOn(u)!.dismiss"
          />
        </li>
      </ul>
    </Card>

    <!-- Audit feed -->
    <Card v-if="canViewAudit" title="Recent activity" sub="audit events">
      <template #actions>
        <Button label="View all" text size="small" @click="router.push('/audit')" />
      </template>
      <EmptyState
        v-if="activityError"
        icon="pi pi-exclamation-triangle"
        title="Couldn't load recent activity"
        :message="activityError"
      >
        <template #actions>
          <Button label="Retry" icon="pi pi-refresh" size="small" @click="loadActivity" />
        </template>
      </EmptyState>
      <EmptyState
        v-else-if="!loading && recentEvents.length === 0"
        icon="pi pi-shield"
        title="No audit events yet"
        message="Activity will appear here as operators sign in and act."
      />
      <!-- Rows are buttons, so this is a plain container rather than a list. -->
      <div v-else class="feed">
        <div
          v-for="ev in recentEvents"
          :key="ev.id"
          class="feed-row clickable"
          role="button"
          tabindex="0"
          @click="openEventDetail(ev)"
          @keydown.enter.prevent="openEventDetail(ev)"
          @keydown.space.prevent="openEventDetail(ev)"
        >
          <span class="feed-icon" :class="`badge-${eventTone(ev.action, ev.result)}`">
            <i :class="eventIcon(ev.action)" />
          </span>
          <div class="feed-msg">
            <span class="actor">{{ ev.actorDisplayName ?? 'system' }}</span>
            <span class="mono"> · {{ ev.action }}</span>
            <span v-if="ev.targetDn" class="dn"> → {{ ev.targetDn }}</span>
            <span
              v-if="ev.result !== 'success'"
              class="badge"
              :class="
                ev.result === 'failure' || ev.result === 'denied' ? 'badge-red' : 'badge-muted'
              "
              style="margin-left: 8px"
            >
              {{ ev.result }}
            </span>
          </div>
          <span class="feed-time mono">{{ fmtRelative(ev.timestamp) }}</span>
        </div>
      </div>
    </Card>

    <AuditEventDialog v-model:visible="detailOpen" :event="detailEvent" />
    <ResetPasswordDialog v-model:visible="resetOpen" :user="resetTarget" @reset="onPasswordReset" />
    <AccountExpiryDialog
      :visible="expiryOpen"
      :expiry="expiry"
      :failure="expiryDialogFailure"
      @close="closeExpiry"
    />
  </div>
</template>

<style scoped>
.dir-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease;
}

.dir-pill:hover {
  background: var(--hover);
}

.dir-pill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.dir-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-4);
}

.dir-pill-dot-green {
  background: var(--green);
}

.dir-pill-dot-red {
  background: var(--red);
}

.dir-pill-dot-amber {
  background: var(--amber);
}

.dir-pill-time {
  font-size: 11px;
  color: var(--text-3);
}

.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.user-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.user-list-item {
  border-bottom: 1px solid var(--border);
}

.user-list-item:last-child {
  border-bottom: 0;
}

.user-list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  cursor: pointer;
}

.user-list-row:hover {
  background: var(--hover);
}

.user-list-meta {
  flex: 1;
  min-width: 0;
}

.user-list-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-list-failure {
  margin: 0 0 10px;
}

.user-list-sub {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.feed-row {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  border-radius: 6px;
}

.feed-row:last-child {
  border-bottom: 0;
}

.feed-row.clickable {
  cursor: pointer;
}

.feed-row.clickable:hover {
  background: var(--hover);
}

.feed-row.clickable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.feed-icon {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  font-size: 11px;
  border-style: solid;
  border-width: 1px;
}

.feed-msg {
  min-width: 0;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feed-msg .actor {
  font-weight: 500;
}

.feed-msg .dn {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.feed-time {
  color: var(--text-3);
  white-space: nowrap;
}
</style>
