<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import Drawer from 'primevue/drawer';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import MultiSelect from 'primevue/multiselect';
import Select from 'primevue/select';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { FilterMatchMode, type FilterMatchModeValue } from '../design/lib/filterMatchMode.js';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import type { UserSummary } from '@openaduc/shared';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import Avatar from '../design/primitives/Avatar.vue';
import StatusBadge from '../design/primitives/StatusBadge.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import { fmtRelative } from '../design/lib/format.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToast();

type AcctStatus = 'enabled' | 'disabled' | 'locked';

// Derived row fields. We pre-compute the search blob, account-status
// bucket, and the day deltas so PrimeVue's built-in filter matchers
// (CONTAINS, IN, GTE, LTE) operate on plain scalars instead of needing
// custom predicates per filter.
interface UserRow extends UserSummary {
  _searchBlob: string;
  _acctStatus: AcctStatus;
  _pwdExpiresInDays: number | null;
  _staleDays: number | null;
}

interface FilterEntry<T> {
  value: T | null;
  matchMode: FilterMatchModeValue;
}

const rows = ref<UserRow[]>([]);
const filteredRows = ref<UserRow[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const drawerOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

const filters = ref<{
  _searchBlob: FilterEntry<string>;
  _acctStatus: FilterEntry<AcctStatus[]>;
  passwordNeverExpires: FilterEntry<boolean>;
  _pwdExpiresInDays: FilterEntry<number>;
  _staleDays: FilterEntry<number>;
  department: FilterEntry<string>;
  title: FilterEntry<string>;
}>({
  _searchBlob: { value: null, matchMode: FilterMatchMode.CONTAINS },
  _acctStatus: { value: null, matchMode: FilterMatchMode.IN },
  passwordNeverExpires: { value: null, matchMode: FilterMatchMode.EQUALS },
  _pwdExpiresInDays: { value: null, matchMode: FilterMatchMode.LESS_THAN_OR_EQUAL_TO },
  _staleDays: { value: null, matchMode: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
  department: { value: null, matchMode: FilterMatchMode.CONTAINS },
  title: { value: null, matchMode: FilterMatchMode.CONTAINS },
});

type FilterKey = keyof typeof filters.value;

const staleModes = [
  { label: 'At least', value: FilterMatchMode.GREATER_THAN_OR_EQUAL_TO },
  { label: 'At most', value: FilterMatchMode.LESS_THAN_OR_EQUAL_TO },
];

const acctStatusOptions = computed<{ label: string; value: AcctStatus }[]>(() => {
  const present = new Set(rows.value.map((r) => r._acctStatus));
  return (
    [
      { label: 'Enabled', value: 'enabled' as const },
      { label: 'Disabled', value: 'disabled' as const },
      { label: 'Locked', value: 'locked' as const },
    ] satisfies { label: string; value: AcctStatus }[]
  ).filter((o) => present.has(o.value));
});

const pwdExpiresOptions = computed<{ label: string; value: boolean }[]>(() => {
  const out: { label: string; value: boolean }[] = [];
  if (rows.value.some((r) => r.passwordNeverExpires)) {
    out.push({ label: 'Never expires', value: true });
  }
  if (rows.value.some((r) => !r.passwordNeverExpires)) {
    out.push({ label: 'Expires', value: false });
  }
  return out;
});

const showStatusFilter = computed(() => acctStatusOptions.value.length > 1);
const showPwdNeverFilter = computed(() => pwdExpiresOptions.value.length > 1);

function computeAcctStatus(u: UserSummary): AcctStatus {
  if (u.locked) return 'locked';
  if (!u.enabled) return 'disabled';
  return 'enabled';
}

function computePwdDays(u: UserSummary): number | null {
  if (u.passwordNeverExpires || !u.passwordExpiresAt) return null;
  const ms = new Date(u.passwordExpiresAt).getTime() - Date.now();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function computeStaleDays(u: UserSummary): number | null {
  if (!u.lastLogonAt) return null;
  const ms = Date.now() - new Date(u.lastLogonAt).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function decorate(u: UserSummary): UserRow {
  const blob = [u.displayName, u.samAccountName, u.userPrincipalName, u.email]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return {
    ...u,
    _searchBlob: blob,
    _acctStatus: computeAcctStatus(u),
    _pwdExpiresInDays: computePwdDays(u),
    _staleDays: computeStaleDays(u),
  };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const resp = await api.users.search({
      pageSize: 50_000,
      sort: 'displayName',
      sortDir: 'asc',
    });
    rows.value = resp.rows.map(decorate);
    filteredRows.value = rows.value;
    total.value = resp.total;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load users';
  } finally {
    loading.value = false;
  }
}

// ---- Selection (for bulk actions) -----------------------------------------
// Selected ids are kept in a Set so toggles are O(1) and the count
// survives across filter changes. With virtual scroll there are no
// "pages" — "select all" instead toggles every currently-visible row.
const selectedIds = ref<Set<string>>(new Set());
const selectedCount = computed(() => selectedIds.value.size);

const allFilteredSelected = computed(
  () =>
    filteredRows.value.length > 0 && filteredRows.value.every((r) => selectedIds.value.has(r.id)),
);
const someFilteredSelected = computed(() =>
  filteredRows.value.some((r) => selectedIds.value.has(r.id)),
);

function toggleSelectAllFiltered(): void {
  const next = new Set(selectedIds.value);
  if (allFilteredSelected.value) {
    for (const r of filteredRows.value) next.delete(r.id);
  } else {
    for (const r of filteredRows.value) next.add(r.id);
  }
  selectedIds.value = next;
}

function toggleSelected(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

function openDetail(row: UserSummary): void {
  void router.push({ name: 'user-detail', params: { id: row.id } });
}

function rowPhotoUrl(row: UserSummary): string | null {
  if (!row.hasPhoto) return null;
  const dirId = auth.actor?.directoryId;
  if (!dirId) return null;
  return api.directories.entra.photoUrl(dirId, row.id);
}

// ---- Filter chips and clear handlers --------------------------------------

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

const acctStatusLabel: Record<AcctStatus, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  locked: 'Locked',
};

const activeChips = computed<Chip[]>(() => {
  const out: Chip[] = [];
  const f = filters.value;
  if (isActive(f._searchBlob.value)) {
    out.push({ key: '_searchBlob', label: `Search: "${f._searchBlob.value}"` });
  }
  if (isActive(f._acctStatus.value)) {
    const labels = (f._acctStatus.value as AcctStatus[]).map((v) => acctStatusLabel[v]);
    out.push({ key: '_acctStatus', label: `Status: ${labels.join(', ')}` });
  }
  if (isActive(f.passwordNeverExpires.value)) {
    out.push({
      key: 'passwordNeverExpires',
      label: f.passwordNeverExpires.value ? 'Pwd: never expires' : 'Pwd: expires',
    });
  }
  if (isActive(f._pwdExpiresInDays.value)) {
    out.push({
      key: '_pwdExpiresInDays',
      label: `Pwd expiring within ${f._pwdExpiresInDays.value}d`,
    });
  }
  if (isActive(f._staleDays.value)) {
    const sym = f._staleDays.matchMode === FilterMatchMode.LESS_THAN_OR_EQUAL_TO ? '≤' : '≥';
    out.push({ key: '_staleDays', label: `Stale ${sym} ${f._staleDays.value}d` });
  }
  if (isActive(f.department.value)) {
    out.push({ key: 'department', label: `Dept: "${f.department.value}"` });
  }
  if (isActive(f.title.value)) {
    out.push({ key: 'title', label: `Title: "${f.title.value}"` });
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

// ---- Deep-link / URL sync -------------------------------------------------
// The dashboard links here with shorthand query params. Translate them on
// mount (and on later URL changes) into the new client-side filter state.
function applyQuery(q: typeof route.query): void {
  const get = (k: string): string | null => (typeof q[k] === 'string' ? q[k] : null);
  const num = (k: string): number | null => {
    const v = get(k);
    if (v == null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const truthy = (k: string): boolean => q[k] === '1' || q[k] === 'true';

  filters.value._searchBlob.value = get('q')?.toLowerCase().trim() || null;

  const status: AcctStatus[] = [];
  if (truthy('locked') || truthy('issues')) status.push('locked');
  if (truthy('disabled') || truthy('issues')) status.push('disabled');
  filters.value._acctStatus.value = status.length > 0 ? status : null;

  filters.value.passwordNeverExpires.value = truthy('passwordNeverExpires') ? true : null;

  const pwd = num('passwordExpiringInDays') ?? (truthy('issues') ? 14 : null);
  filters.value._pwdExpiresInDays.value = pwd;

  filters.value._staleDays.value = num('staleSinceDays');
  filters.value.department.value = get('department');
  filters.value.title.value = null;
}

function syncQuery(): void {
  const f = filters.value;
  const q: Record<string, string> = {};
  if (isActive(f._searchBlob.value)) q.q = f._searchBlob.value as string;
  if (isActive(f._acctStatus.value)) {
    const v = f._acctStatus.value as AcctStatus[];
    if (v.includes('locked')) q.locked = '1';
    if (v.includes('disabled')) q.disabled = '1';
  }
  if (f.passwordNeverExpires.value === true) q.passwordNeverExpires = '1';
  if (isActive(f._pwdExpiresInDays.value)) {
    q.passwordExpiringInDays = String(f._pwdExpiresInDays.value);
  }
  if (isActive(f._staleDays.value)) q.staleSinceDays = String(f._staleDays.value);
  if (isActive(f.department.value)) q.department = (f.department.value as string).trim();
  void router.replace({ path: '/users', query: q });
}

// Apply incoming query to filter state, then keep state→URL in sync.
let suppressSync = true;
watch(
  () => route.query,
  (next) => {
    suppressSync = true;
    applyQuery(next);
    suppressSync = false;
  },
);

watch(
  filters,
  () => {
    if (!suppressSync) syncQuery();
  },
  { deep: true },
);

// ---- CSV export (client-side) --------------------------------------------
// Generate from filteredRows so the export honors whatever the operator
// is looking at right now. Replaces the server-side /users/export.csv
// path; with all rows already in memory there's no reason to re-query.
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(): void {
  const cols: { header: string; pick: (r: UserRow) => unknown }[] = [
    { header: 'Display name', pick: (r) => r.displayName ?? '' },
    { header: 'Username', pick: (r) => r.samAccountName },
    { header: 'UPN', pick: (r) => r.userPrincipalName ?? '' },
    { header: 'Email', pick: (r) => r.email ?? '' },
    { header: 'Status', pick: (r) => acctStatusLabel[r._acctStatus] },
    { header: 'Pwd never expires', pick: (r) => (r.passwordNeverExpires ? 'yes' : '') },
    { header: 'Pwd expires', pick: (r) => r.passwordExpiresAt ?? '' },
    { header: 'Last logon', pick: (r) => r.lastLogonAt ?? '' },
    { header: 'Department', pick: (r) => r.department ?? '' },
    { header: 'Title', pick: (r) => r.title ?? '' },
    { header: 'Modified', pick: (r) => r.modifiedAtSource ?? '' },
  ];
  const lines = [cols.map((c) => csvEscape(c.header)).join(',')];
  for (const r of filteredRows.value) {
    lines.push(cols.map((c) => csvEscape(c.pick(r))).join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast.add({
    severity: 'info',
    summary: 'Export ready',
    detail: `${filteredRows.value.length} ${filteredRows.value.length === 1 ? 'row' : 'rows'} exported.`,
    life: 3000,
  });
}

// ---- Bulk actions ---------------------------------------------------------
type BulkAction = 'disable' | 'enable' | 'unlock';
const pendingBulkAction = ref<BulkAction | null>(null);
const bulkRunning = ref(false);
const bulkProgress = ref<{
  done: number;
  total: number;
  failures: { id: string; error: string }[];
}>({
  done: 0,
  total: 0,
  failures: [],
});
const canBulkDisable = computed(() => auth.hasCapability('write:user.enableDisable'));
const canBulkUnlock = computed(() => auth.hasCapability('write:user.unlock'));

async function startBulk(action: BulkAction): Promise<void> {
  if (selectedIds.value.size === 0) return;
  pendingBulkAction.value = action;
  const ids = Array.from(selectedIds.value);
  bulkRunning.value = true;
  bulkProgress.value = { done: 0, total: ids.length, failures: [] };
  try {
    for (const id of ids) {
      try {
        if (action === 'disable') await api.users.disable(id);
        else if (action === 'enable') await api.users.enable(id);
        else if (action === 'unlock') await api.users.unlock(id);
      } catch (err) {
        bulkProgress.value.failures.push({
          id,
          error: err instanceof ApiError ? err.message : String(err),
        });
      } finally {
        bulkProgress.value = { ...bulkProgress.value, done: bulkProgress.value.done + 1 };
      }
    }
    const succeeded = bulkProgress.value.total - bulkProgress.value.failures.length;
    if (bulkProgress.value.failures.length === 0) {
      const verb = action === 'disable' ? 'Disabled' : action === 'enable' ? 'Enabled' : 'Unlocked';
      toast.add({
        severity: 'success',
        summary: `${verb} ${succeeded} ${succeeded === 1 ? 'account' : 'accounts'}`,
        life: 4000,
      });
    } else {
      toast.add({
        severity: 'warn',
        summary: `${succeeded} succeeded, ${bulkProgress.value.failures.length} failed`,
        detail: bulkProgress.value.failures
          .slice(0, 3)
          .map((f) => f.error)
          .join('; '),
        life: 8000,
      });
    }
    clearSelection();
    await load();
  } finally {
    bulkRunning.value = false;
    pendingBulkAction.value = null;
  }
}

const bulkBusyMessage = computed(() => {
  if (!bulkRunning.value) return null;
  return `${bulkProgress.value.done} of ${bulkProgress.value.total} done`;
});

// ---- Display helpers ------------------------------------------------------
type PwdTone = 'red' | 'amber' | 'violet' | 'muted';

function pwdExpiryTone(u: UserSummary): PwdTone {
  if (u.passwordNeverExpires) return 'violet';
  if (!u.passwordExpiresAt) return 'muted';
  const ms = new Date(u.passwordExpiresAt).getTime() - Date.now();
  const days = ms / (24 * 60 * 60 * 1000);
  if (days < 0) return 'red';
  if (days <= 14) return 'amber';
  return 'muted';
}

function pwdExpiryLabel(u: UserSummary): string {
  if (u.passwordNeverExpires) return 'Never';
  if (!u.passwordExpiresAt) return '—';
  const ms = new Date(u.passwordExpiresAt).getTime() - Date.now();
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days < 0) return `Exp ${Math.abs(days)}d ago`;
  if (days === 0) return 'Today';
  return `${days}d`;
}

function pwdHasDot(u: UserSummary): boolean {
  return u.passwordNeverExpires === true || !!u.passwordExpiresAt;
}

onMounted(() => {
  // Hydrate from URL before the first watch fires so the initial filter
  // state matches the deep-link without immediately rewriting it.
  applyQuery(route.query);
  suppressSync = false;
  void load();
  if (!isActive(filters.value._searchBlob.value)) {
    searchInput.value?.focus();
  }
});
</script>

<template>
  <Toast />
  <div class="page-inner page-fill users-page">
    <PageHeader :title="`Users (${total.toLocaleString()})`">
      <template #actions>
        <Button
          :label="activeCount > 0 ? `Filter (${activeCount})` : 'Filter'"
          icon="pi pi-filter"
          :severity="activeCount > 0 ? 'primary' : 'secondary'"
          :outlined="activeCount === 0"
          @click="drawerOpen = true"
        />
        <Button
          v-if="auth.hasCapability('export:user')"
          label="Export CSV"
          icon="pi pi-download"
          severity="secondary"
          outlined
          @click="exportCsv"
        />
        <Button
          v-if="auth.hasCapability('read:user.deleted')"
          label="Deleted users"
          icon="pi pi-trash"
          severity="secondary"
          outlined
          @click="router.push({ name: 'deleted-users' })"
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
      sort-field="displayName"
      :sort-order="1"
      scrollable
      scroll-height="flex"
      :virtual-scroller-options="{ itemSize: 56 }"
      class="users-table"
      @value-change="(v: UserRow[]) => (filteredRows = v)"
      @row-click="(ev) => openDetail(ev.data as UserSummary)"
    >
      <template #empty>
        <EmptyState
          icon="pi pi-search"
          :title="activeCount > 0 ? 'No users match these filters' : 'No users yet'"
          :message="
            activeCount > 0
              ? 'Try widening or clearing the filters.'
              : 'Once the directory has finished syncing, users will appear here.'
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

      <Column class="select-col" :style="{ width: '36px' }" header-style="width: 36px">
        <template #header>
          <input
            type="checkbox"
            class="row-check"
            :checked="allFilteredSelected"
            :indeterminate.prop="!allFilteredSelected && someFilteredSelected"
            :aria-label="allFilteredSelected ? 'Deselect all visible' : 'Select all visible'"
            @click.stop="toggleSelectAllFiltered"
          />
        </template>
        <template #body="{ data }">
          <input
            type="checkbox"
            class="row-check"
            :checked="selectedIds.has(data.id)"
            :aria-label="`Select ${data.displayName ?? data.samAccountName}`"
            @click.stop="toggleSelected(data.id)"
          />
        </template>
      </Column>

      <Column header="User" field="displayName" sortable :style="{ minWidth: '260px' }">
        <template #body="{ data }">
          <div class="user-cell">
            <Avatar
              :name="data.displayName ?? data.samAccountName"
              :seed="data.samAccountName"
              :size="28"
              :photo-url="rowPhotoUrl(data)"
            />
            <div class="user-cell-stack">
              <div class="user-name">{{ data.displayName ?? data.samAccountName }}</div>
              <div class="user-meta">{{ data.userPrincipalName ?? data.samAccountName }}</div>
            </div>
          </div>
        </template>
      </Column>
      <Column header="Status" field="_acctStatus" sortable :style="{ width: '140px' }">
        <template #body="{ data }">
          <StatusBadge :user="data" />
        </template>
      </Column>
      <Column header="Pwd expires" field="passwordExpiresAt" sortable :style="{ width: '160px' }">
        <template #body="{ data }">
          <span
            class="badge"
            :class="`badge-${pwdExpiryTone(data)}`"
            :title="data.passwordNeverExpires ? 'DONT_EXPIRE_PASSWORD set' : undefined"
          >
            <span v-if="pwdHasDot(data)" class="badge-dot" />
            {{ pwdExpiryLabel(data) }}
          </span>
        </template>
      </Column>
      <Column field="department" header="Department" sortable :style="{ width: '180px' }">
        <template #body="{ data }">
          <span class="cell-muted">{{ data.department ?? '—' }}</span>
        </template>
      </Column>
      <Column field="title" header="Title" sortable :style="{ width: '180px' }">
        <template #body="{ data }">
          <span class="cell-muted">{{ data.title ?? '—' }}</span>
        </template>
      </Column>
      <Column header="Last logon" field="lastLogonAt" sortable :style="{ width: '140px' }">
        <template #body="{ data }">
          <span class="cell-mono">{{
            data.lastLogonAt ? fmtRelative(data.lastLogonAt) : '—'
          }}</span>
        </template>
      </Column>
      <Column header="Modified" field="modifiedAtSource" sortable :style="{ width: '140px' }">
        <template #body="{ data }">
          <span class="cell-mono">{{
            data.modifiedAtSource ? fmtRelative(data.modifiedAtSource) : '—'
          }}</span>
        </template>
      </Column>
    </DataTable>

    <transition name="bulk-fade">
      <div v-if="selectedCount > 0" class="bulkbar" role="region" aria-label="Bulk actions">
        <span class="bulkbar-count mono">
          <strong>{{ selectedCount }}</strong> selected
        </span>
        <span class="bulkbar-divider" />
        <div class="bulkbar-actions">
          <Button
            v-if="canBulkUnlock"
            label="Unlock"
            icon="pi pi-unlock"
            severity="warn"
            size="small"
            :loading="bulkRunning && pendingBulkAction === 'unlock'"
            :disabled="bulkRunning"
            @click="auth.requireEdit(() => startBulk('unlock'))"
          />
          <Button
            v-if="canBulkDisable"
            label="Disable"
            icon="pi pi-ban"
            severity="danger"
            size="small"
            :loading="bulkRunning && pendingBulkAction === 'disable'"
            :disabled="bulkRunning"
            @click="auth.requireEdit(() => startBulk('disable'))"
          />
          <Button
            v-if="canBulkDisable"
            label="Enable"
            icon="pi pi-check"
            severity="secondary"
            size="small"
            :loading="bulkRunning && pendingBulkAction === 'enable'"
            :disabled="bulkRunning"
            @click="auth.requireEdit(() => startBulk('enable'))"
          />
          <Button
            label="Clear"
            icon="pi pi-times"
            text
            severity="secondary"
            size="small"
            :disabled="bulkRunning"
            @click="clearSelection"
          />
        </div>
        <span v-if="bulkBusyMessage" class="bulkbar-progress mono">{{ bulkBusyMessage }}</span>
      </div>
    </transition>

    <Drawer
      v-model:visible="drawerOpen"
      position="right"
      header="Filters"
      :style="{ width: '380px' }"
    >
      <div class="filter-form">
        <div class="filter-field">
          <label class="filter-label">Search</label>
          <InputText
            ref="searchInput"
            v-model="filters._searchBlob.value"
            placeholder="Name, username, UPN, email…"
            class="filter-input"
          />
        </div>

        <div v-if="showStatusFilter" class="filter-field">
          <label class="filter-label">Account status</label>
          <MultiSelect
            v-model="filters._acctStatus.value"
            :options="acctStatusOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div v-if="showPwdNeverFilter" class="filter-field">
          <label class="filter-label">Password</label>
          <Select
            v-model="filters.passwordNeverExpires.value"
            :options="pwdExpiresOptions"
            option-label="label"
            option-value="value"
            placeholder="Any"
            class="filter-input"
            show-clear
          />
        </div>

        <div class="filter-field">
          <label class="filter-label">Pwd expiring within (days)</label>
          <InputNumber
            v-model="filters._pwdExpiresInDays.value"
            :min="0"
            placeholder="14"
            class="filter-input"
            show-buttons
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

        <div class="filter-field">
          <label class="filter-label">Department</label>
          <InputText
            v-model="filters.department.value"
            placeholder="Contains…"
            class="filter-input"
          />
        </div>

        <div class="filter-field">
          <label class="filter-label">Title</label>
          <InputText v-model="filters.title.value" placeholder="Contains…" class="filter-input" />
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
.users-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;
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

.user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.user-cell-stack {
  min-width: 0;
  line-height: 1.25;
}

.user-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}

.user-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-muted {
  color: var(--text-2);
}

:deep(.users-table .select-col),
:deep(.users-table th.select-col) {
  padding-left: 12px !important;
  padding-right: 4px !important;
}

:deep(.users-table .p-datatable-tbody > tr > td.select-col + td),
:deep(.users-table .p-datatable-thead > tr > th.select-col + th) {
  padding-left: 8px !important;
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

.row-check {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}

:deep(.users-table) {
  border: 1px solid var(--border);
}

/* Bulk action bar */
.bulkbar {
  position: sticky;
  bottom: 16px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px auto 0;
  width: max-content;
  max-width: 100%;
  padding: 8px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  box-shadow: var(--shadow-lg);
  font-size: 12.5px;
  align-self: center;
}

.bulkbar-count {
  color: var(--text-2);
  font-size: 12px;
}

.bulkbar-count strong {
  color: var(--text);
  font-weight: 600;
}

.bulkbar-divider {
  width: 1px;
  height: 16px;
  background: var(--border-strong);
}

.bulkbar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.bulkbar-progress {
  font-size: 11.5px;
  color: var(--text-3);
}

.bulk-fade-enter-active,
.bulk-fade-leave-active {
  transition:
    opacity 0.18s,
    transform 0.18s;
}

.bulk-fade-enter-from,
.bulk-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
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
