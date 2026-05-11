<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { api, type DirectorySummary, type SyncTaskSummary } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import Card from '../design/primitives/Card.vue';
import KpiCard from '../design/primitives/KpiCard.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import Message from 'primevue/message';
import SyncTasksTable from './settings/SyncTasksTable.vue';
import { fmtRelative } from '../design/lib/format.js';

const auth = useAuthStore();
const toast = useToast();

const directories = ref<DirectorySummary[]>([]);
// Per-directory aggregated stats so the KPI strip and per-directory headers
// can render without re-fetching the full task table for each row.
const tasksByDir = ref<Record<number, SyncTaskSummary[]>>({});
const loading = ref(true);

const canEdit = auth.hasCapability('configure:directory');

async function loadDirectories(): Promise<void> {
  try {
    const r = await api.directories.list();
    directories.value = r.directories;
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load directories',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  }
}

async function loadTasksFor(d: DirectorySummary): Promise<void> {
  if (!d.syncBindUpn || !d.hasSyncBindPassword) {
    // No service account — there are no tasks to fetch yet. Render the
    // directory section with a "needs SA" hint instead.
    tasksByDir.value = { ...tasksByDir.value, [d.id]: [] };
    return;
  }
  try {
    const r = await api.directories.syncTasks.list(d.id);
    tasksByDir.value = { ...tasksByDir.value, [d.id]: r.tasks };
  } catch (err) {
    // Best-effort — keep whatever we had so a transient failure doesn't
    // wipe the section.
    toast.add({
      severity: 'warn',
      summary: `Could not refresh ${d.displayName ?? d.domain}`,
      detail: err instanceof Error ? err.message : String(err),
      life: 4000,
    });
  }
}

async function load(): Promise<void> {
  loading.value = true;
  await loadDirectories();
  await Promise.all(directories.value.map(loadTasksFor));
  loading.value = false;
}

// All tasks across every directory — the KPI strip + sort.
const allTasks = computed<{ directoryId: number; task: SyncTaskSummary }[]>(() => {
  const out: { directoryId: number; task: SyncTaskSummary }[] = [];
  for (const d of directories.value) {
    for (const t of tasksByDir.value[d.id] ?? []) {
      out.push({ directoryId: d.id, task: t });
    }
  }
  return out;
});

const runningCount = computed(
  () => allTasks.value.filter((x) => x.task.lastStatus === 'running').length,
);
const failingCount = computed(
  () => allTasks.value.filter((x) => x.task.consecutiveFailures > 0).length,
);
const totalEnabled = computed(() => allTasks.value.filter((x) => x.task.enabled).length);

const lastActivity = computed<Date | null>(() => {
  let best: number | null = null;
  for (const x of allTasks.value) {
    const t = x.task.lastFinishedAt ? new Date(x.task.lastFinishedAt).getTime() : null;
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best);
});

// Poll every 4s while anything is running across any directory. Otherwise
// the page is static — operators usually open it, look, and close it.
const anyRunning = computed(() => runningCount.value > 0);
let pollHandle: ReturnType<typeof setInterval> | null = null;
watch(anyRunning, (running) => {
  if (running && pollHandle === null) {
    pollHandle = setInterval(() => {
      void Promise.all(directories.value.map(loadTasksFor));
    }, 4000);
  } else if (!running && pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
});

onMounted(load);
onUnmounted(() => {
  if (pollHandle !== null) clearInterval(pollHandle);
});

function dirSubtitle(d: DirectorySummary): string {
  const parts = [d.domain];
  const tasks = tasksByDir.value[d.id] ?? [];
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function dirStatusTone(d: DirectorySummary): string {
  const tasks = tasksByDir.value[d.id] ?? [];
  if (!d.syncBindUpn || !d.hasSyncBindPassword) return 'badge-muted';
  if (tasks.some((t) => t.lastStatus === 'running')) return 'badge-amber';
  if (tasks.some((t) => t.consecutiveFailures > 0)) return 'badge-red';
  if (tasks.length === 0) return 'badge-muted';
  return 'badge-green';
}

function dirStatusLabel(d: DirectorySummary): string {
  if (!d.syncBindUpn || !d.hasSyncBindPassword) return 'no service account';
  const tasks = tasksByDir.value[d.id] ?? [];
  if (tasks.length === 0) return 'awaiting first tick';
  const running = tasks.filter((t) => t.lastStatus === 'running').length;
  if (running > 0) return `${running} running`;
  const failing = tasks.filter((t) => t.consecutiveFailures > 0).length;
  if (failing > 0) return `${failing} failing`;
  return 'healthy';
}
</script>

<template>
  <Toast />
  <div class="page-inner tasks-page">
    <PageHeader title="Tasks & Scheduler" />

    <div class="kpi-row">
      <KpiCard label="Active tasks" :value="totalEnabled" icon="pi pi-clock" />
      <KpiCard
        label="Running now"
        :value="runningCount"
        icon="pi pi-sync"
        :accent="runningCount > 0 ? 'var(--amber)' : null"
      />
      <KpiCard
        label="Failing"
        :value="failingCount"
        icon="pi pi-exclamation-triangle"
        :accent="failingCount > 0 ? 'var(--red)' : null"
      />
      <KpiCard
        label="Last activity"
        :value="lastActivity ? fmtRelative(lastActivity) : '—'"
        icon="pi pi-history"
      />
    </div>

    <Card v-if="loading && directories.length === 0" title="Loading…">
      <p class="hint" style="margin: 0">Fetching directories…</p>
    </Card>

    <EmptyState
      v-else-if="directories.length === 0"
      icon="pi pi-server"
      title="No directories configured"
      message="Add a directory in Settings → Configuration before scheduling sync tasks."
    />

    <template v-else>
      <Card
        v-for="d in directories"
        :key="d.id"
        :title="d.displayName ?? d.name"
        :sub="dirSubtitle(d)"
      >
        <template #actions>
          <span class="badge" :class="dirStatusTone(d)">
            <span class="badge-dot" /> {{ dirStatusLabel(d) }}
          </span>
        </template>

        <Message v-if="!d.syncBindUpn || !d.hasSyncBindPassword" severity="info" :closable="false">
          Background sync requires a service account. Add one in
          <RouterLink to="/settings?tab=directory">Configuration → Domains</RouterLink>
          to start scheduling tasks.
        </Message>

        <SyncTasksTable v-else :directory-id="d.id" :can-edit="canEdit" />
      </Card>
    </template>
  </div>
</template>

<style scoped>
.tasks-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.hint {
  color: var(--text-3);
  font-size: 13px;
}
</style>
