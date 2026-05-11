<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import DataTable, { type DataTablePageEvent } from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import type { DeletedComputerSummary } from '@openaduc/shared';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import { fmtRelative } from '../design/lib/format.js';

const router = useRouter();
const auth = useAuthStore();

const rows = ref<DeletedComputerSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(25);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');

let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  // The endpoint binds as the operator, so it 403s without edit mode. Bail
  // early and render the gate panel instead of provoking an error.
  if (!auth.editMode) return;
  loading.value = true;
  error.value = null;
  try {
    const params: Record<string, string | number> = {
      page: page.value,
      pageSize: pageSize.value,
    };
    if (search.value.trim()) params.q = search.value.trim();
    const resp = await api.deletedComputers.search(params);
    rows.value = resp.rows;
    total.value = resp.total;
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 403
        ? 'Your account does not have permission to view deleted computers (or your editing session expired).'
        : err instanceof Error
          ? err.message
          : 'Failed to load deleted computers';
  } finally {
    loading.value = false;
  }
}

watch(
  () => auth.editMode,
  (now, prev) => {
    if (now && !prev) {
      void load();
    } else if (!now && prev) {
      rows.value = [];
      total.value = 0;
      error.value = null;
    }
  },
);

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 250);
}

function onPage(ev: DataTablePageEvent): void {
  page.value = ev.page + 1;
  pageSize.value = ev.rows;
  void load();
}

onMounted(() => {
  if (auth.editMode) void load();
});
</script>

<template>
  <Toast />
  <div class="page-inner deleted-computers-page">
    <PageHeader title="Deleted computers" :sub="`${total.toLocaleString()} tombstones`">
      <template #actions>
        <Button
          label="Back to computers"
          icon="pi pi-arrow-left"
          severity="secondary"
          outlined
          @click="router.push({ name: 'computer-search' })"
        />
        <Button
          label="Refresh"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :loading="loading"
          @click="load"
        />
      </template>
    </PageHeader>

    <!-- Edit-mode gate. Same rationale as deleted users: the endpoint binds
         as the operator (not the service account), so what they see is
         governed by their AD permissions. The cached step-up password is
         what makes that bind possible. -->
    <div v-if="!auth.editMode" class="gate-panel">
      <i class="pi pi-lock gate-icon" />
      <div class="gate-stack">
        <strong>Editing required to view deleted computers</strong>
        <p class="gate-body">
          The deleted-computers list reads Active Directory as your account, not the service
          account, so the entries you see depend on your AD permissions. Turn on
          <strong>Editing</strong> in the top bar to enter your password — the page will load
          automatically.
        </p>
      </div>
    </div>

    <template v-else>
      <Message severity="info" :closable="false">
        <div class="banner-stack">
          <strong>Read-only view</strong>
          <span class="banner-body">
            Tombstoned computer accounts are listed for reference. Restore is not exposed in this
            version — re-join the machine to the domain instead.
          </span>
        </div>
      </Message>

      <div class="filterbar">
        <div class="search">
          <i class="pi pi-search search-icon" />
          <input
            v-model="search"
            type="text"
            placeholder="Search by hostname, sAM, FQDN, or OS…"
            @input="onSearchInput"
          />
        </div>
      </div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <DataTable
        :value="rows"
        :loading="loading"
        lazy
        paginator
        :rows="pageSize"
        :total-records="total"
        :first="(page - 1) * pageSize"
        :rows-per-page-options="[10, 25, 50, 100]"
        data-key="id"
        class="deleted-computers-table"
        @page="onPage"
      >
        <template #empty>
          <EmptyState
            icon="pi pi-trash"
            :title="search ? 'No deleted computers match' : 'No tombstoned computers'"
            :message="
              search
                ? 'Try a different search term.'
                : 'Deleted computer accounts will appear here while AD still has them.'
            "
          >
            <template v-if="search" #actions>
              <Button
                label="Clear search"
                icon="pi pi-times"
                severity="secondary"
                outlined
                size="small"
                @click="
                  search = '';
                  load();
                "
              />
            </template>
          </EmptyState>
        </template>
        <Column header="Name" :style="{ minWidth: '220px' }">
          <template #body="{ data }">
            <div class="cmp-cell">
              <div class="cmp-name">{{ data.cn ?? data.samAccountName ?? '—' }}</div>
              <div class="cmp-meta mono">{{ data.dnsHostName ?? data.samAccountName ?? '—' }}</div>
            </div>
          </template>
        </Column>
        <Column header="Operating system" :style="{ width: '24%', maxWidth: '0' }">
          <template #body="{ data }">
            <span v-if="data.operatingSystem" class="cell-mono">{{ data.operatingSystem }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
        </Column>
        <Column header="Last known parent" :style="{ width: '34%', maxWidth: '0' }">
          <template #body="{ data }">
            <span v-if="data.lastKnownParent" class="dn-cell mono" :title="data.lastKnownParent">{{
              data.lastKnownParent
            }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
        </Column>
        <Column header="Deleted" :style="{ width: '120px' }">
          <template #body="{ data }">
            <span v-if="data.deletedAt" class="cell-mono" :title="data.deletedAt">{{
              fmtRelative(data.deletedAt)
            }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
        </Column>
        <Column header="" :style="{ width: '90px' }">
          <template #body="{ data }">
            <span
              v-if="data.recycled"
              class="badge badge-muted mono"
              title="recycled — past restore window"
            >
              recycled
            </span>
          </template>
        </Column>
      </DataTable>
    </template>
  </div>
</template>

<style scoped>
.deleted-computers-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;
}

.banner-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gate-panel {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 24px;
  margin-top: 8px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  background: var(--surface-2);
}

.gate-icon {
  font-size: 28px;
  color: var(--text-3);
  margin-top: 2px;
}

.gate-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
}

.gate-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
}

.banner-body {
  font-size: 12.5px;
  color: var(--text-2);
}

.cmp-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}

.cmp-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmp-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

.cell-muted {
  color: var(--text-3);
}

.dn-cell {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
  width: 100%;
}
</style>
