<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import Drawer from 'primevue/drawer';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import MultiSelect from 'primevue/multiselect';
import Select from 'primevue/select';
import Message from 'primevue/message';
import { FilterMatchMode, type FilterMatchModeValue } from '../design/lib/filterMatchMode.js';
import { api } from '../api/index.js';
import type { ComputerSummary } from '@openaduc/shared';
import PageHeader from '../design/primitives/PageHeader.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import Avatar from '../design/primitives/Avatar.vue';
import { fmtRelative } from '../design/lib/format.js';

const router = useRouter();

// Derived `_staleDays` lets the operator filter "machines that haven't
// logged on in N+ days" using a plain numeric matcher. Computed once
// at load so the filter doesn't keep walking row dates.
interface CmpRow extends ComputerSummary {
  _staleDays: number | null;
}

interface FilterEntry<T> {
  value: T | null;
  matchMode: FilterMatchModeValue;
}

const rows = ref<CmpRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const drawerOpen = ref(false);

const filters = ref<{
  name: FilterEntry<string>;
  operatingSystem: FilterEntry<string[]>;
  enabled: FilterEntry<boolean>;
  _staleDays: FilterEntry<number>;
}>({
  name: { value: null, matchMode: FilterMatchMode.CONTAINS },
  operatingSystem: { value: null, matchMode: FilterMatchMode.IN },
  enabled: { value: null, matchMode: FilterMatchMode.EQUALS },
  _staleDays: { value: null, matchMode: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
});

type FilterKey = keyof typeof filters.value;

const staleModes = [
  { label: 'At least', value: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
  { label: 'At most', value: FilterMatchMode.LESS_THAN_OR_EQUAL_TO },
];

const osOptions = computed<{ label: string; value: string }[]>(() => {
  const present = new Set<string>();
  for (const r of rows.value) {
    if (r.operatingSystem) present.add(r.operatingSystem);
  }
  return [...present].sort().map((v) => ({ label: v, value: v }));
});

const enabledOptions = computed<{ label: string; value: boolean }[]>(() => {
  const out: { label: string; value: boolean }[] = [];
  if (rows.value.some((r) => r.enabled)) out.push({ label: 'Enabled', value: true });
  if (rows.value.some((r) => !r.enabled)) out.push({ label: 'Disabled', value: false });
  return out;
});

const showOsFilter = computed(() => osOptions.value.length > 1);
const showEnabledFilter = computed(() => enabledOptions.value.length > 1);

function decorate(c: ComputerSummary): CmpRow {
  let staleDays: number | null = null;
  if (c.lastLogonAt) {
    const ms = Date.now() - new Date(c.lastLogonAt).getTime();
    staleDays = Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
  }
  return { ...c, _staleDays: staleDays };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const resp = await api.computers.search({ pageSize: 50_000, sort: 'name', sortDir: 'asc' });
    rows.value = resp.rows.map(decorate);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load computers';
  } finally {
    loading.value = false;
  }
}

const total = computed(() => rows.value.length);

function openDetail(row: ComputerSummary): void {
  void router.push({ name: 'computer-detail', params: { id: row.id } });
}

function isActive(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

interface Chip {
  key: FilterKey;
  label: string;
}

const activeChips = computed<Chip[]>(() => {
  const out: Chip[] = [];
  const f = filters.value;
  if (isActive(f.name.value)) {
    out.push({ key: 'name', label: `Name: "${f.name.value}"` });
  }
  if (isActive(f.operatingSystem.value)) {
    const labels = f.operatingSystem.value as string[];
    out.push({ key: 'operatingSystem', label: `OS: ${labels.join(', ')}` });
  }
  if (isActive(f.enabled.value)) {
    out.push({ key: 'enabled', label: `Status: ${f.enabled.value ? 'Enabled' : 'Disabled'}` });
  }
  if (isActive(f._staleDays.value)) {
    const sym = f._staleDays.matchMode === FilterMatchMode.LESS_THAN_OR_EQUAL_TO ? '≤' : '≥';
    out.push({ key: '_staleDays', label: `Stale ${sym} ${f._staleDays.value}d` });
  }
  return out;
});

const activeCount = computed(() => activeChips.value.length);

function clearFilter(key: FilterKey): void {
  filters.value[key].value = null;
}

function clearAll(): void {
  for (const k of Object.keys(filters.value) as FilterKey[]) {
    filters.value[k].value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-inner page-fill computers-page">
    <PageHeader :title="`Computers (${total.toLocaleString()})`">
      <template #actions>
        <Button
          :label="activeCount > 0 ? `Filter (${activeCount})` : 'Filter'"
          icon="pi pi-filter"
          :severity="activeCount > 0 ? 'primary' : 'secondary'"
          :outlined="activeCount === 0"
          @click="drawerOpen = true"
        />
        <Button
          label="Deleted computers"
          icon="pi pi-trash"
          severity="secondary"
          outlined
          @click="router.push({ name: 'deleted-computers' })"
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

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="activeCount > 0" class="chip-strip">
      <button
        v-for="chip in activeChips"
        :key="chip.key"
        type="button"
        class="filter-chip"
        @click="clearFilter(chip.key)"
      >
        <span>{{ chip.label }}</span>
        <i class="pi pi-times" />
      </button>
      <button type="button" class="filter-chip clear-all" @click="clearAll">Clear all</button>
    </div>

    <DataTable
      v-model:filters="filters"
      :value="rows"
      :loading="loading"
      data-key="id"
      removable-sort
      sort-field="name"
      :sort-order="1"
      scrollable
      scroll-height="flex"
      :virtual-scroller-options="{ itemSize: 56 }"
      @row-click="(ev) => openDetail(ev.data as ComputerSummary)"
      class="computers-table"
    >
      <template #empty>
        <EmptyState
          icon="pi pi-desktop"
          :title="activeCount > 0 ? 'No computers match these filters' : 'No computers yet'"
          :message="
            activeCount > 0
              ? 'Try widening or clearing the filters.'
              : 'Once the directory has finished syncing, computers will appear here.'
          "
        >
          <template v-if="activeCount > 0" #actions>
            <Button
              label="Clear filters"
              severity="secondary"
              outlined
              size="small"
              @click="clearAll"
            />
          </template>
        </EmptyState>
      </template>
      <Column header="Name" field="name" sortable class="col-name">
        <template #body="{ data }">
          <div class="cmp-cell">
            <Avatar
              :name="data.name ?? data.samAccountName"
              :seed="data.samAccountName ?? data.distinguishedName"
              :size="28"
              shape="rounded"
              icon="pi-desktop"
            />
            <div class="cmp-stack">
              <div class="cmp-name" :title="data.name ?? data.distinguishedName">
                {{ data.name ?? data.distinguishedName }}
              </div>
              <div v-if="data.dnsHostName" class="cmp-meta mono" :title="data.dnsHostName">
                {{ data.dnsHostName }}
              </div>
              <div v-else-if="data.samAccountName" class="cmp-meta mono">
                {{ data.samAccountName }}
              </div>
            </div>
          </div>
        </template>
      </Column>
      <Column header="Operating system" field="operatingSystem" sortable class="col-os">
        <template #body="{ data }">
          <div v-if="data.operatingSystem" class="os-stack">
            <span class="os-name">{{ data.operatingSystem }}</span>
            <span v-if="data.operatingSystemVersion" class="os-version mono">{{
              data.operatingSystemVersion
            }}</span>
          </div>
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>
      <Column header="Status" field="enabled" sortable class="col-status">
        <template #body="{ data }">
          <span v-if="data.enabled" class="badge badge-green badge-collapse" title="enabled">
            <i class="pi pi-check-circle" /><span class="badge-text">enabled</span>
          </span>
          <span v-else class="badge badge-red badge-collapse" title="disabled">
            <i class="pi pi-ban" /><span class="badge-text">disabled</span>
          </span>
        </template>
      </Column>
      <Column header="Last logon" field="lastLogonAt" sortable class="col-logon">
        <template #body="{ data }">
          <span v-if="data.lastLogonAt" class="cell-mono" :title="data.lastLogonAt">{{
            fmtRelative(data.lastLogonAt)
          }}</span>
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>
    </DataTable>

    <Drawer
      v-model:visible="drawerOpen"
      position="right"
      header="Filters"
      :style="{ width: '380px' }"
    >
      <div class="filter-form">
        <div class="filter-field">
          <label class="filter-label">Name</label>
          <InputText
            v-model="filters.name.value"
            placeholder="Hostname, sAM, or FQDN…"
            class="filter-input"
          />
        </div>

        <div v-if="showOsFilter" class="filter-field">
          <label class="filter-label">Operating system</label>
          <MultiSelect
            v-model="filters.operatingSystem.value"
            :options="osOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
            filter
          />
        </div>

        <div v-if="showEnabledFilter" class="filter-field">
          <label class="filter-label">Status</label>
          <Select
            v-model="filters.enabled.value"
            :options="enabledOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div class="filter-field">
          <label class="filter-label">Stale (days since last logon)</label>
          <div class="filter-row">
            <Select
              v-model="filters._staleDays.matchMode"
              :options="staleModes"
              option-label="label"
              option-value="value"
              class="filter-mode"
            />
            <InputNumber
              v-model="filters._staleDays.value"
              :min="0"
              placeholder="30"
              class="filter-input filter-input-grow"
              show-buttons
            />
          </div>
        </div>
      </div>

      <template #footer>
        <div class="filter-footer">
          <Button
            label="Clear all"
            severity="secondary"
            text
            :disabled="activeCount === 0"
            @click="clearAll"
          />
          <Button label="Done" severity="primary" @click="drawerOpen = false" />
        </div>
      </template>
    </Drawer>
  </div>
</template>

<style scoped>
.computers-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chip-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
  color: var(--text);
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s;
}

.filter-chip:hover {
  background: color-mix(in oklab, var(--accent) 22%, var(--surface));
}

.filter-chip i {
  font-size: 10px;
  color: var(--text-3);
}

.filter-chip.clear-all {
  background: transparent;
  border-color: var(--border);
  color: var(--text-2);
}

.filter-chip.clear-all:hover {
  background: var(--surface-2);
}

.cmp-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.cmp-mark {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-2);
  display: grid;
  place-items: center;
  font-size: 13px;
  border: 1px solid var(--border);
}

.cmp-stack {
  min-width: 0;
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

.os-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.os-name {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.os-version {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
}

.cell-muted {
  color: var(--text-3);
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

:deep(.computers-table) {
  border: 1px solid var(--border);
}

:deep(.computers-table .p-datatable-table) {
  table-layout: fixed;
  width: 100%;
}

:deep(.computers-table .col-name) {
  width: auto;
}

:deep(.computers-table .col-os) {
  width: 26%;
}

:deep(.computers-table .col-status) {
  width: 140px;
}

:deep(.computers-table .col-logon) {
  width: 150px;
}

:deep(.computers-table td) {
  overflow: hidden;
}

/* When the page is narrow, the status badge collapses to its icon. The
   column still needs to be wide enough for "Status ↑↓" so its arrows
   don't bleed into the adjacent Last logon header. */
@media (max-width: 1100px) {
  :deep(.computers-table .badge-collapse) {
    padding: 0 5px;
    gap: 0;
  }
  :deep(.computers-table .badge-collapse .badge-text) {
    display: none;
  }
  :deep(.computers-table .col-status) {
    width: 100px;
  }
}

.filter-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 4px;
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.filter-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.filter-input {
  width: 100%;
}

.filter-footer {
  display: flex;
  justify-content: space-between;
  width: 100%;
}
</style>
