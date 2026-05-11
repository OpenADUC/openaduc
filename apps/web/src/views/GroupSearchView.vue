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
import type { GroupSummary } from '@openaduc/shared';
import PageHeader from '../design/primitives/PageHeader.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import Avatar from '../design/primitives/Avatar.vue';

const router = useRouter();

type GroupType = GroupSummary['groupType'];
type GroupScope = GroupSummary['groupScope'];

interface FilterEntry<T> {
  value: T | null;
  matchMode: FilterMatchModeValue;
}

const rows = ref<GroupSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const drawerOpen = ref(false);

const filters = ref<{
  name: FilterEntry<string>;
  groupType: FilterEntry<GroupType[]>;
  groupScope: FilterEntry<GroupScope[]>;
  memberCount: FilterEntry<number>;
}>({
  name: { value: null, matchMode: FilterMatchMode.CONTAINS },
  groupType: { value: null, matchMode: FilterMatchMode.IN },
  groupScope: { value: null, matchMode: FilterMatchMode.IN },
  memberCount: { value: null, matchMode: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
});

type FilterKey = keyof typeof filters.value;

const memberCountModes = [
  { label: 'At least', value: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
  { label: 'At most', value: FilterMatchMode.LESS_THAN_OR_EQUAL_TO },
  { label: 'Exactly', value: FilterMatchMode.EQUALS },
];

const typeOptions = computed<{ label: string; value: GroupType }[]>(() => {
  const present = new Set(rows.value.map((r) => r.groupType));
  return (
    [
      { label: 'Security', value: 'security' as const },
      { label: 'Distribution', value: 'distribution' as const },
    ] satisfies { label: string; value: GroupType }[]
  ).filter((opt) => present.has(opt.value));
});

const scopeOptions = computed<{ label: string; value: GroupScope }[]>(() => {
  const present = new Set(rows.value.map((r) => r.groupScope));
  return (
    [
      { label: 'Global', value: 'global' as const },
      { label: 'Domain-local', value: 'domain-local' as const },
      { label: 'Universal', value: 'universal' as const },
    ] satisfies { label: string; value: GroupScope }[]
  ).filter((opt) => present.has(opt.value));
});

const showTypeFilter = computed(() => typeOptions.value.length > 1);
const showScopeFilter = computed(() => scopeOptions.value.length > 1);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // Pull the entire dataset in one shot — the page-size cap was raised
    // to 50_000 specifically so the operator can filter/sort locally
    // without re-hitting the API for every keystroke.
    const resp = await api.groups.search({ pageSize: 50_000, sort: 'name', sortDir: 'asc' });
    rows.value = resp.rows;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load groups';
  } finally {
    loading.value = false;
  }
}

const total = computed(() => rows.value.length);

function openDetail(row: GroupSummary): void {
  void router.push({ name: 'group-detail', params: { id: row.id } });
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
  if (isActive(f.groupType.value)) {
    const labels = (f.groupType.value as GroupType[]).map(
      (v) => typeOptions.value.find((o) => o.value === v)?.label ?? v,
    );
    out.push({ key: 'groupType', label: `Type: ${labels.join(', ')}` });
  }
  if (isActive(f.groupScope.value)) {
    const labels = (f.groupScope.value as GroupScope[]).map(
      (v) => scopeOptions.value.find((o) => o.value === v)?.label ?? v,
    );
    out.push({ key: 'groupScope', label: `Scope: ${labels.join(', ')}` });
  }
  if (isActive(f.memberCount.value)) {
    const op = f.memberCount.matchMode;
    const sym =
      op === FilterMatchMode.LESS_THAN_OR_EQUAL_TO
        ? '≤'
        : op === FilterMatchMode.EQUALS
          ? '='
          : '≥';
    out.push({ key: 'memberCount', label: `Members ${sym} ${f.memberCount.value}` });
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
  <div class="page-inner page-fill groups-page">
    <PageHeader :title="`Groups (${total.toLocaleString()})`">
      <template #actions>
        <Button
          :label="activeCount > 0 ? `Filter (${activeCount})` : 'Filter'"
          icon="pi pi-filter"
          :severity="activeCount > 0 ? 'primary' : 'secondary'"
          :outlined="activeCount === 0"
          @click="drawerOpen = true"
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
      @row-click="(ev) => openDetail(ev.data as GroupSummary)"
      class="groups-table"
    >
      <template #empty>
        <EmptyState
          icon="pi pi-users"
          :title="activeCount > 0 ? 'No groups match these filters' : 'No groups yet'"
          :message="
            activeCount > 0
              ? 'Try widening or clearing the filters.'
              : 'Once the directory has finished syncing, groups will appear here.'
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
          <div class="grp-cell">
            <Avatar
              :name="data.name ?? data.samAccountName"
              :seed="data.samAccountName ?? data.distinguishedName"
              :size="28"
              shape="rounded"
            />
            <div class="grp-stack">
              <div class="grp-name" :title="data.name ?? data.distinguishedName">
                {{ data.name ?? data.distinguishedName }}
              </div>
              <div v-if="data.description" class="grp-desc" :title="data.description">
                {{ data.description }}
              </div>
            </div>
          </div>
        </template>
      </Column>
      <Column header="Type" field="groupType" sortable class="col-type">
        <template #body="{ data }">
          <span
            v-if="data.groupType === 'security'"
            class="badge badge-blue badge-collapse"
            title="security"
          >
            <i class="pi pi-shield" /><span class="badge-text">security</span>
          </span>
          <span
            v-else-if="data.groupType === 'distribution'"
            class="badge badge-violet badge-collapse"
            title="distribution"
          >
            <i class="pi pi-envelope" /><span class="badge-text">distribution</span>
          </span>
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>
      <Column header="Scope" field="groupScope" sortable class="col-scope">
        <template #body="{ data }">
          <span
            v-if="data.groupScope === 'global'"
            class="badge badge-amber badge-collapse"
            title="global"
          >
            <i class="pi pi-globe" /><span class="badge-text">global</span>
          </span>
          <span
            v-else-if="data.groupScope === 'domain-local'"
            class="badge badge-amber badge-collapse"
            title="domain-local"
          >
            <i class="pi pi-home" /><span class="badge-text">domain-local</span>
          </span>
          <span
            v-else-if="data.groupScope === 'universal'"
            class="badge badge-amber badge-collapse"
            title="universal"
          >
            <i class="pi pi-sitemap" /><span class="badge-text">universal</span>
          </span>
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>
      <Column header="Members" field="memberCount" sortable class="col-members">
        <template #body="{ data }">
          <span class="cell-mono">{{ data.memberCount.toLocaleString() }}</span>
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
          <InputText v-model="filters.name.value" placeholder="Contains…" class="filter-input" />
        </div>

        <div v-if="showTypeFilter" class="filter-field">
          <label class="filter-label">Type</label>
          <MultiSelect
            v-model="filters.groupType.value"
            :options="typeOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div v-if="showScopeFilter" class="filter-field">
          <label class="filter-label">Scope</label>
          <MultiSelect
            v-model="filters.groupScope.value"
            :options="scopeOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div class="filter-field">
          <label class="filter-label">Members</label>
          <div class="filter-row">
            <Select
              v-model="filters.memberCount.matchMode"
              :options="memberCountModes"
              option-label="label"
              option-value="value"
              class="filter-mode"
            />
            <InputNumber
              v-model="filters.memberCount.value"
              :min="0"
              placeholder="0"
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
.groups-page {
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

.grp-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.grp-mark {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 6px;
  background: var(--violet-soft);
  color: var(--violet);
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.grp-stack {
  min-width: 0;
}

.grp-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.grp-desc {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-muted {
  color: var(--text-3);
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

:deep(.groups-table) {
  border: 1px solid var(--border);
}

:deep(.groups-table .p-datatable-table) {
  table-layout: fixed;
  width: 100%;
}

:deep(.groups-table .col-name) {
  width: auto;
}

:deep(.groups-table .col-type) {
  width: 140px;
}

:deep(.groups-table .col-scope) {
  width: 160px;
}

:deep(.groups-table .col-members) {
  width: 110px;
  text-align: right;
}

:deep(.groups-table .col-members .p-datatable-column-header-content) {
  justify-content: flex-end;
}

:deep(.groups-table td) {
  overflow: hidden;
}

/* When the page is narrow (drawer open or small viewport), badge labels
   collapse to icon-only. Width must still cover the header text plus the
   sort arrows, otherwise neighbouring header labels run into each other. */
@media (max-width: 1100px) {
  :deep(.groups-table .badge-collapse) {
    padding: 0 5px;
    gap: 0;
  }
  :deep(.groups-table .badge-collapse .badge-text) {
    display: none;
  }
  :deep(.groups-table .col-type) {
    width: 92px;
  }
  :deep(.groups-table .col-scope) {
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
