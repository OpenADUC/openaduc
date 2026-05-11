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
import DatePicker from 'primevue/datepicker';
import Message from 'primevue/message';
import { FilterMatchMode, type FilterMatchModeValue } from '../design/lib/filterMatchMode.js';
import { api } from '../api/index.js';
import type { GroupPolicySummary } from '@openaduc/shared';
import PageHeader from '../design/primitives/PageHeader.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import Avatar from '../design/primitives/Avatar.vue';
import { fmtRelative } from '../design/lib/format.js';

const router = useRouter();

type StatusKind = 'on' | 'user-only' | 'computer-only' | 'off';
type ConfiguresKind = 'user' | 'computer' | 'both' | 'none';

interface GpoRow extends GroupPolicySummary {
  _status: StatusKind;
  _configuresKind: ConfiguresKind;
  _hasWmi: boolean;
  _modifiedDate: Date | null;
}

const rows = ref<GpoRow[]>([]);
const fetchedAt = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const drawerOpen = ref(false);

// PrimeVue's filter state. The DataTable does the actual filtering off
// of this object — we just supply our own UI for editing the values
// (drawer + chips) instead of the per-column funnel popovers.
interface FilterEntry<T> {
  value: T | null;
  matchMode: FilterMatchModeValue;
}

const filters = ref<{
  displayName: FilterEntry<string>;
  _status: FilterEntry<StatusKind[]>;
  linkCount: FilterEntry<number>;
  _configuresKind: FilterEntry<ConfiguresKind[]>;
  _hasWmi: FilterEntry<boolean>;
  _modifiedDate: FilterEntry<Date>;
}>({
  displayName: { value: null, matchMode: FilterMatchMode.CONTAINS },
  _status: { value: null, matchMode: FilterMatchMode.IN },
  linkCount: { value: null, matchMode: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
  _configuresKind: { value: null, matchMode: FilterMatchMode.IN },
  _hasWmi: { value: null, matchMode: FilterMatchMode.EQUALS },
  _modifiedDate: { value: null, matchMode: FilterMatchMode.DATE_AFTER },
});

type FilterKey = keyof typeof filters.value;

const linkCountModes = [
  { label: 'At least', value: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
  { label: 'At most', value: FilterMatchMode.LESS_THAN_OR_EQUAL_TO },
  { label: 'Exactly', value: FilterMatchMode.EQUALS },
];

const modifiedModes = [
  { label: 'After', value: FilterMatchMode.DATE_AFTER },
  { label: 'Before', value: FilterMatchMode.DATE_BEFORE },
  { label: 'On', value: FilterMatchMode.DATE_IS },
];

// Filter dropdowns reflect what's actually in the loaded data — pre-
// populating with all four statuses lets operators check options that
// can't possibly match anything in this dataset.
const statusOptions = computed<{ label: string; value: StatusKind }[]>(() => {
  const present = new Set(rows.value.map((r) => r._status));
  return (
    [
      { label: 'enabled', value: 'on' as const },
      { label: 'user only', value: 'user-only' as const },
      { label: 'computer only', value: 'computer-only' as const },
      { label: 'disabled', value: 'off' as const },
    ] satisfies { label: string; value: StatusKind }[]
  ).filter((opt) => present.has(opt.value));
});

const configuresOptions = computed<{ label: string; value: ConfiguresKind }[]>(() => {
  const present = new Set(rows.value.map((r) => r._configuresKind));
  return (
    [
      { label: 'User & computer', value: 'both' as const },
      { label: 'User only', value: 'user' as const },
      { label: 'Computer only', value: 'computer' as const },
      { label: 'Nothing', value: 'none' as const },
    ] satisfies { label: string; value: ConfiguresKind }[]
  ).filter((opt) => present.has(opt.value));
});

const wmiOptions = computed<{ label: string; value: boolean }[]>(() => {
  const out: { label: string; value: boolean }[] = [];
  if (rows.value.some((r) => r._hasWmi)) out.push({ label: 'Has WMI filter', value: true });
  if (rows.value.some((r) => !r._hasWmi)) out.push({ label: 'No WMI filter', value: false });
  return out;
});

// A column's filter is only worth surfacing when there's more than one
// distinct value in the data. With a single value, every row matches
// every selection — the control becomes a footgun.
const showStatusFilter = computed(() => statusOptions.value.length > 1);
const showConfiguresFilter = computed(() => configuresOptions.value.length > 1);
const showWmiFilter = computed(() => wmiOptions.value.length > 1);

function statusKind(p: GroupPolicySummary): StatusKind {
  if (p.userPolicyEnabled && p.computerPolicyEnabled) return 'on';
  if (p.userPolicyEnabled) return 'user-only';
  if (p.computerPolicyEnabled) return 'computer-only';
  return 'off';
}

function configuresKind(p: GroupPolicySummary): ConfiguresKind {
  const u = p.userExtensionGuids.length > 0;
  const c = p.computerExtensionGuids.length > 0;
  if (u && c) return 'both';
  if (u) return 'user';
  if (c) return 'computer';
  return 'none';
}

function statusLabel(kind: StatusKind): string {
  switch (kind) {
    case 'on':
      return 'enabled';
    case 'user-only':
      return 'user only';
    case 'computer-only':
      return 'computer only';
    case 'off':
      return 'disabled';
  }
}

function decorate(p: GroupPolicySummary): GpoRow {
  return {
    ...p,
    _status: statusKind(p),
    _configuresKind: configuresKind(p),
    _hasWmi: !!p.wmiFilterRef,
    _modifiedDate: p.modifiedAtSource ? new Date(p.modifiedAtSource) : null,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const resp = await api.groupPolicies.list();
    rows.value = resp.policies.map(decorate);
    fetchedAt.value = resp.fetchedAt;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load group policies';
  } finally {
    loading.value = false;
  }
}

const total = computed(() => rows.value.length);

function openDetail(row: GroupPolicySummary): void {
  void router.push({ name: 'group-policy-detail', params: { id: row.id } });
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
  if (isActive(f.displayName.value)) {
    out.push({ key: 'displayName', label: `Name: "${f.displayName.value}"` });
  }
  if (isActive(f._status.value)) {
    const labels = (f._status.value as StatusKind[]).map(
      (v) => statusOptions.value.find((o) => o.value === v)?.label ?? v,
    );
    out.push({ key: '_status', label: `Sections: ${labels.join(', ')}` });
  }
  if (isActive(f.linkCount.value)) {
    const op = f.linkCount.matchMode;
    const sym =
      op === FilterMatchMode.LESS_THAN_OR_EQUAL_TO
        ? '≤'
        : op === FilterMatchMode.EQUALS
          ? '='
          : '≥';
    out.push({ key: 'linkCount', label: `Links ${sym} ${f.linkCount.value}` });
  }
  if (isActive(f._configuresKind.value)) {
    const labels = (f._configuresKind.value as ConfiguresKind[]).map(
      (v) => configuresOptions.value.find((o) => o.value === v)?.label ?? v,
    );
    out.push({ key: '_configuresKind', label: `Configures: ${labels.join(', ')}` });
  }
  if (isActive(f._hasWmi.value)) {
    out.push({
      key: '_hasWmi',
      label: `WMI: ${f._hasWmi.value ? 'has filter' : 'no filter'}`,
    });
  }
  if (isActive(f._modifiedDate.value)) {
    const op = f._modifiedDate.matchMode;
    const verb =
      op === FilterMatchMode.DATE_BEFORE
        ? 'before'
        : op === FilterMatchMode.DATE_IS
          ? 'on'
          : 'after';
    const d = f._modifiedDate.value as Date;
    out.push({
      key: '_modifiedDate',
      label: `Modified ${verb} ${d.toLocaleDateString()}`,
    });
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
  <div class="page-inner page-fill gpo-page">
    <PageHeader :title="`Group Policy (${total.toLocaleString()})`">
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

    <!-- Active-filter chips. Visible only when any filter is set so the
         row collapses cleanly when nothing's active. Each chip's × clears
         just that filter; the trailing button clears all of them. -->
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
      sort-field="modifiedAtSource"
      :sort-order="-1"
      scrollable
      scroll-height="flex"
      :virtual-scroller-options="{ itemSize: 56 }"
      class="gpo-table"
      @row-click="(ev) => openDetail(ev.data as GroupPolicySummary)"
    >
      <template #empty>
        <EmptyState
          icon="pi pi-clipboard"
          :title="activeCount > 0 ? 'No GPOs match these filters' : 'No group policies'"
          :message="
            activeCount > 0
              ? 'Try widening or clearing the filters.'
              : `The directory has no GPC objects, or the bind account can't read CN=Policies,CN=System.`
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

      <Column header="Name" field="displayName" sortable class="col-name">
        <template #body="{ data }">
          <div class="gpo-cell">
            <Avatar
              :name="data.displayName ?? data.gpoGuid"
              :seed="data.gpoGuid"
              :size="28"
              shape="rounded"
              icon="pi-clipboard"
            />
            <div class="gpo-stack">
              <div class="gpo-name" :title="data.displayName ?? data.gpoGuid">
                {{ data.displayName ?? data.gpoGuid }}
              </div>
              <div class="gpo-meta mono" :title="data.gpoGuid">{{ data.gpoGuid }}</div>
            </div>
          </div>
        </template>
      </Column>

      <Column header="Sections" field="_status" sortable class="col-status">
        <template #body="{ data }">
          <span
            class="badge"
            :class="{
              'badge-green': data._status === 'on',
              'badge-amber': data._status === 'user-only' || data._status === 'computer-only',
              'badge-red': data._status === 'off',
            }"
            :title="`flags=${data.flagsRaw ?? 0}`"
          >
            {{ statusLabel(data._status) }}
          </span>
        </template>
      </Column>

      <Column header="Links" field="linkCount" sortable class="col-num">
        <template #body="{ data }">
          <span v-if="data.linkCount > 0" class="badge badge-blue">{{ data.linkCount }}</span>
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>

      <Column header="Configures" field="_configuresKind" sortable class="col-configures">
        <template #body="{ data }">
          <span
            v-if="data.userExtensionGuids.length === 0 && data.computerExtensionGuids.length === 0"
            class="cell-muted mono"
            >nothing</span
          >
          <span v-else class="cfg-stack">
            <span v-if="data.userExtensionGuids.length > 0" class="cfg-pill">
              <i class="pi pi-user" />{{ data.userExtensionGuids.length }} user
            </span>
            <span v-if="data.computerExtensionGuids.length > 0" class="cfg-pill">
              <i class="pi pi-desktop" />{{ data.computerExtensionGuids.length }} computer
            </span>
          </span>
        </template>
      </Column>

      <Column header="WMI" field="_hasWmi" sortable class="col-icon">
        <template #body="{ data }">
          <i
            v-if="data.wmiFilterRef"
            class="pi pi-filter cell-icon-on"
            :title="data.wmiFilterRef"
          />
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>

      <Column header="Modified" field="modifiedAtSource" sortable class="col-date">
        <template #body="{ data }">
          <span v-if="data.modifiedAtSource" class="cell-mono" :title="data.modifiedAtSource">
            {{ fmtRelative(data.modifiedAtSource) }}
          </span>
          <span v-else class="cell-muted mono">—</span>
        </template>
      </Column>
    </DataTable>

    <Drawer
      v-model:visible="drawerOpen"
      position="right"
      header="Filters"
      class="filter-drawer"
      :style="{ width: '380px' }"
    >
      <div class="filter-form">
        <div class="filter-field">
          <label class="filter-label">Name</label>
          <InputText
            v-model="filters.displayName.value"
            placeholder="Contains…"
            class="filter-input"
          />
        </div>

        <div v-if="showStatusFilter" class="filter-field">
          <label class="filter-label">Sections</label>
          <MultiSelect
            v-model="filters._status.value"
            :options="statusOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div class="filter-field">
          <label class="filter-label">Links</label>
          <div class="filter-row">
            <Select
              v-model="filters.linkCount.matchMode"
              :options="linkCountModes"
              option-label="label"
              option-value="value"
              class="filter-mode"
            />
            <InputNumber
              v-model="filters.linkCount.value"
              :min="0"
              placeholder="0"
              class="filter-input filter-input-grow"
              show-buttons
            />
          </div>
        </div>

        <div v-if="showConfiguresFilter" class="filter-field">
          <label class="filter-label">Configures</label>
          <MultiSelect
            v-model="filters._configuresKind.value"
            :options="configuresOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div v-if="showWmiFilter" class="filter-field">
          <label class="filter-label">WMI filter</label>
          <Select
            v-model="filters._hasWmi.value"
            :options="wmiOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div class="filter-field">
          <label class="filter-label">Modified</label>
          <div class="filter-row">
            <Select
              v-model="filters._modifiedDate.matchMode"
              :options="modifiedModes"
              option-label="label"
              option-value="value"
              class="filter-mode"
            />
            <DatePicker
              v-model="filters._modifiedDate.value"
              date-format="yy-mm-dd"
              placeholder="yyyy-mm-dd"
              class="filter-input filter-input-grow"
              show-icon
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
.gpo-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Active-filter chip strip. Renders as a thin row of pill-buttons; each
   click clears that one filter. The trailing "Clear all" mirrors the
   drawer footer button so users don't have to open the drawer to reset. */
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

.gpo-table :deep(table) {
  table-layout: fixed;
  width: 100%;
}

.gpo-table :deep(.col-name) {
  width: auto;
}
.gpo-table :deep(.col-status) {
  width: 110px;
}
.gpo-table :deep(.col-num) {
  width: 90px;
  text-align: center;
}
.gpo-table :deep(.col-configures) {
  width: 150px;
  white-space: nowrap;
}
.gpo-table :deep(.col-icon) {
  width: 70px;
  text-align: center;
}
.gpo-table :deep(.col-date) {
  width: 130px;
  white-space: nowrap;
}

.cfg-stack {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.cfg-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-2);
  white-space: nowrap;
}

.cfg-pill i {
  font-size: 10.5px;
  color: var(--text-3);
}

.cell-icon-on {
  color: var(--text-2);
  font-size: 13px;
}

.gpo-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.gpo-mark {
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

.gpo-stack {
  min-width: 0;
}

.gpo-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gpo-meta {
  font-size: 11px;
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

/* Drawer form layout: vertical stack of labeled fields. The matchMode
   pickers (Links, Modified) sit inline with their value input so the
   operator and operand read as one expression. */
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
