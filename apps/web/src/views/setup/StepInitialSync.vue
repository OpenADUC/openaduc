<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import ProgressBar from 'primevue/progressbar';
import { api, type InitialSyncJob } from '../../api/index.js';
import { ApiError } from '../../api/client.js';

const emit = defineEmits<{ complete: [job: InitialSyncJob] }>();

const job = ref<InitialSyncJob | null>(null);
const starting = ref(false);
const retrying = ref(false);
const startError = ref<string | null>(null);
let pollHandle: ReturnType<typeof setTimeout> | null = null;
let unloadHandler: ((e: BeforeUnloadEvent) => string | undefined) | null = null;

const totalTasks = computed(() => job.value?.tasks.length ?? 0);
const completedTasks = computed(
  () => (job.value?.tasks ?? []).filter((t) => t.status === 'succeeded').length,
);
const progressPercent = computed(() => {
  if (!totalTasks.value) return 0;
  return Math.round((completedTasks.value / totalTasks.value) * 100);
});

const failedTask = computed(() => job.value?.tasks.find((t) => t.status === 'failed') ?? null);

const isRunning = computed(() => job.value?.status === 'running');
const isFailed = computed(() => job.value?.status === 'failed');

function statusIcon(status: string): string {
  if (status === 'succeeded') return 'pi pi-check-circle';
  if (status === 'failed') return 'pi pi-exclamation-circle';
  if (status === 'running') return 'pi pi-spin pi-spinner';
  return 'pi pi-circle';
}

function statSummary(stats: Record<string, unknown> | null): string {
  if (!stats) return '';
  const interesting: Array<[string, string]> = [
    ['users', 'users'],
    ['groups', 'groups'],
    ['computers', 'computers'],
    ['ous', 'OUs'],
    ['memberships', 'memberships'],
    ['count', 'records'],
    ['scanned', 'scanned'],
    ['inserted', 'new'],
    ['updated', 'updated'],
  ];
  const parts: string[] = [];
  for (const [key, label] of interesting) {
    const v = (stats as Record<string, unknown>)[key];
    if (typeof v === 'number') parts.push(`${v.toLocaleString()} ${label}`);
  }
  return parts.join(' · ');
}

async function poll(): Promise<void> {
  try {
    const result = await api.setup.initialSyncStatus();
    job.value = result.job;
    if (result.job?.status === 'succeeded') {
      stopPolling();
      detachUnloadGuard();
      emit('complete', result.job);
      return;
    }
    if (result.job?.status === 'failed') {
      stopPolling();
      detachUnloadGuard();
      return;
    }
  } catch {
    // Transient — keep polling.
  }
  schedulePoll();
}

function schedulePoll(): void {
  pollHandle = setTimeout(() => {
    void poll();
  }, 1500);
}
function stopPolling(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
}

function attachUnloadGuard(): void {
  if (unloadHandler) return;
  unloadHandler = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = 'Initial sync is still running. Leaving will pause progress.';
    return e.returnValue;
  };
  window.addEventListener('beforeunload', unloadHandler);
}
function detachUnloadGuard(): void {
  if (!unloadHandler) return;
  window.removeEventListener('beforeunload', unloadHandler);
  unloadHandler = null;
}

async function start(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  startError.value = null;
  try {
    const result = await api.setup.runInitialSync();
    job.value = result.job;
    attachUnloadGuard();
    schedulePoll();
  } catch (err) {
    startError.value =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Could not start initial sync';
  } finally {
    starting.value = false;
  }
}

async function retry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    const result = await api.setup.retryTask();
    job.value = result.job;
    if (result.job.status === 'running') {
      attachUnloadGuard();
      schedulePoll();
    }
  } catch (err) {
    startError.value =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Retry failed';
  } finally {
    retrying.value = false;
  }
}

onMounted(async () => {
  try {
    const status = await api.setup.initialSyncStatus();
    if (status.job) {
      job.value = status.job;
      if (status.job.status === 'running') {
        attachUnloadGuard();
        schedulePoll();
      } else if (status.job.status === 'succeeded') {
        emit('complete', status.job);
      }
    } else {
      await start();
    }
  } catch {
    await start();
  }
});

onBeforeUnmount(() => {
  stopPolling();
  detachUnloadGuard();
});
</script>

<template>
  <div class="step">
    <header class="head">
      <h2 class="title">Loading your directory</h2>
      <p class="sub">
        Each task runs once, sequentially, with full pages — so you start with a complete dataset
        before background sync takes over.
      </p>
    </header>

    <Message v-if="isRunning" severity="info" :closable="false">
      Keep this window open until the sync finishes.
    </Message>
    <Message v-if="isFailed && failedTask" severity="error" :closable="false">
      <strong>{{ failedTask.label }}</strong> failed: {{ failedTask.error }}
    </Message>
    <Message v-if="startError" severity="error" :closable="false">{{ startError }}</Message>

    <div class="progress">
      <div class="progress-head">
        <span class="progress-label">
          <template v-if="isRunning">Running…</template>
          <template v-else-if="job?.status === 'succeeded'">Complete</template>
          <template v-else-if="isFailed">Stopped on error</template>
          <template v-else>Preparing…</template>
        </span>
        <span class="progress-count">{{ completedTasks }} / {{ totalTasks }}</span>
      </div>
      <ProgressBar :value="progressPercent" :show-value="false" />
    </div>

    <ul class="task-list">
      <li
        v-for="task in job?.tasks ?? []"
        :key="task.key"
        class="task"
        :class="`status-${task.status}`"
      >
        <i :class="statusIcon(task.status)" class="task-icon" />
        <div class="task-body">
          <div class="task-name">{{ task.label }}</div>
          <div v-if="task.status === 'running'" class="task-meta">running…</div>
          <div v-else-if="task.status === 'succeeded'" class="task-meta">
            {{ statSummary(task.stats) || 'done' }}
          </div>
          <div v-else-if="task.status === 'failed'" class="task-meta error">
            {{ task.error }}
          </div>
          <div v-else class="task-meta pending">queued</div>
        </div>
      </li>
    </ul>

    <div v-if="isFailed" class="actions">
      <Button
        type="button"
        :label="`Retry ${failedTask?.label ?? 'failed task'}`"
        icon="pi pi-refresh"
        :loading="retrying"
        @click="retry"
      />
    </div>
  </div>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: #18181b;
}
.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #18181b;
}
.sub {
  margin: 0;
  font-size: 13px;
  color: #52525b;
  line-height: 1.45;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.progress-label {
  font-size: 12.5px;
  font-weight: 600;
  color: #18181b;
}
.progress-count {
  font-size: 12px;
  color: #71717a;
  font-family: var(--font-mono);
}

.task-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.task {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #e7e7ea;
  border-radius: 7px;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.task.status-running {
  border-color: #c7d2fe;
  background: #eef2ff;
}
.task.status-succeeded {
  border-color: #bbf7d0;
  background: #f0fdf4;
}
.task.status-failed {
  border-color: #fecaca;
  background: #fef2f2;
}
.task.status-pending {
  opacity: 0.6;
}

.task-icon {
  font-size: 14px;
  margin-top: 3px;
  flex-shrink: 0;
}
.task.status-succeeded .task-icon {
  color: #16a34a;
}
.task.status-failed .task-icon {
  color: #dc2626;
}
.task.status-running .task-icon {
  color: #4f46e5;
}
.task.status-pending .task-icon {
  color: #a1a1aa;
}

.task-body {
  flex: 1;
  min-width: 0;
}
.task-name {
  font-size: 13px;
  font-weight: 500;
  color: #18181b;
}
.task-meta {
  font-size: 11.5px;
  color: #71717a;
  font-family: var(--font-mono);
  margin-top: 1px;
}
.task-meta.error {
  color: #dc2626;
  font-family: inherit;
}
.task-meta.pending {
  color: #a1a1aa;
}

.actions {
  display: flex;
  justify-content: flex-end;
}

:deep(.p-progressbar) {
  height: 6px;
  background: #e7e7ea;
  border-radius: 999px;
}
:deep(.p-progressbar .p-progressbar-value) {
  background: #4f46e5;
  border-radius: 999px;
}
:deep(.p-button) {
  padding: 7px 14px;
  font-size: 13px;
}
:deep(.p-message) {
  margin: 0;
  font-size: 12.5px;
}
:deep(.p-message .p-message-wrapper) {
  padding: 8px 12px;
}
</style>
