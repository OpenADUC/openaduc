<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DataTable, {
  type DataTablePageEvent,
  type DataTableRowClickEvent,
} from 'primevue/datatable';
import Column from 'primevue/column';
import Select from 'primevue/select';
import Button from 'primevue/button';
import Message from 'primevue/message';
import DatePicker from 'primevue/datepicker';
import { api, type AuditEventRow } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import Avatar from '../design/primitives/Avatar.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import SignInEventsList from '../design/primitives/SignInEventsList.vue';
import SignInEventDetailDialog from '../design/feedback/SignInEventDetailDialog.vue';
import AuditEventDialog from '../design/feedback/AuditEventDialog.vue';
import type { MfaRegistrationRow, MfaRegistrationStatus, SignInEventApp } from '@openaduc/shared';
import { fmtAbsolute, fmtRelative } from '../design/lib/format.js';

// Three tabs: 'log' (local audit trail of admin/operator actions),
// 'signins' (Entra sign-in events, cached locally), and 'mfa' (MFA
// registration snapshot across users — who's enrolled, with which
// methods). All Entra-side tabs assume an Entra integration is
// configured; otherwise their content shows a guidance message.
type TabId = 'log' | 'signins' | 'mfa';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const directoryId = computed(() => auth.actor?.directoryId ?? null);

const activeTab = ref<TabId>('log');

watchEffect(() => {
  const fromQuery = route.query.tab;
  if (fromQuery === 'signins' || fromQuery === 'log' || fromQuery === 'mfa') {
    activeTab.value = fromQuery;
  }
});

function selectTab(id: TabId): void {
  activeTab.value = id;
  void router.replace({ path: '/audit', query: { tab: id } });
}

// ---- Sign-in tab filters ---------------------------------------------
// Independent of the local-audit filters so switching tabs doesn't
// blow away either set. The list component refetches when any of these
// props change; we wrap dates in computed ISO strings so DatePicker's
// Date object plays nicely with the API.
const signInSearch = ref('');
const signInAppId = ref<string>('');
const signInStatus = ref<'success' | 'failure' | 'all'>('all');
const signInFrom = ref<Date | null>(null);
const signInTo = ref<Date | null>(null);
const signInRefreshKey = ref(0);
const signInApps = ref<SignInEventApp[]>([]);

const signInStatusOptions = [
  { label: 'All results', value: 'all' as const },
  { label: 'Success only', value: 'success' as const },
  { label: 'Failure only', value: 'failure' as const },
];

const signInAppOptions = computed(() => [
  { label: 'All applications', value: '' },
  ...signInApps.value.map((a) => ({
    label: a.displayName ?? a.id,
    value: a.id,
  })),
]);

const signInFromIso = computed(() => signInFrom.value?.toISOString() ?? '');
const signInToIso = computed(() => signInTo.value?.toISOString() ?? '');

// Debounced search box → updates a separate trailing ref so we don't
// fire a query for every keystroke.
const signInSearchInput = ref('');
let signInSearchTimer: ReturnType<typeof setTimeout> | undefined;
watch(signInSearchInput, (next) => {
  if (signInSearchTimer) clearTimeout(signInSearchTimer);
  signInSearchTimer = setTimeout(() => {
    signInSearch.value = next;
  }, 250);
});

function clearSignInFilters(): void {
  signInSearchInput.value = '';
  signInSearch.value = '';
  signInAppId.value = '';
  signInStatus.value = 'all';
  signInFrom.value = null;
  signInTo.value = null;
  signInRefreshKey.value++;
}

const signInActiveFilterCount = computed(() => {
  let n = 0;
  if (signInSearch.value) n++;
  if (signInAppId.value) n++;
  if (signInStatus.value !== 'all') n++;
  if (signInFrom.value || signInTo.value) n++;
  return n;
});

// Load the distinct apps list once when the Sign-ins tab is first
// shown — gives the operator a real dropdown of apps that have
// actually had sign-ins, rather than a free-text guessing game.
async function loadSignInApps(): Promise<void> {
  if (directoryId.value === null) return;
  try {
    const r = await api.directories.entra.signInEventApps(directoryId.value);
    signInApps.value = r.apps;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('failed to load sign-in apps', err);
  }
}

watch(activeTab, (next) => {
  if (next === 'signins' && signInApps.value.length === 0) {
    void loadSignInApps();
  }
});

// Detail modal state
const signInDialogOpen = ref(false);
const signInDialogEventId = ref<string | null>(null);
function onSignInSelect(id: string): void {
  signInDialogEventId.value = id;
  signInDialogOpen.value = true;
}

// ---- MFA registration tab --------------------------------------------
// State + filters live in this view (rather than a child component) so
// the filter row can sit alongside the table without prop-drilling.
// Data is small (one row per user, ~thousands max) so we keep the
// whole page in memory and let DataTable lazy-paginate.

const mfaRows = ref<MfaRegistrationRow[]>([]);
const mfaTotal = ref(0);
const mfaPage = ref(1);
const mfaPageSize = ref(50);
const mfaLoading = ref(false);
const mfaError = ref<string | null>(null);
const mfaMethods = ref<string[]>([]);

const mfaStatus = ref<MfaRegistrationStatus>('all');
const mfaMethod = ref<string>('');
const mfaSearchInput = ref('');
const mfaSearch = ref('');
let mfaSearchTimer: ReturnType<typeof setTimeout> | undefined;
watch(mfaSearchInput, (next) => {
  if (mfaSearchTimer) clearTimeout(mfaSearchTimer);
  mfaSearchTimer = setTimeout(() => {
    mfaSearch.value = next;
  }, 250);
});

const mfaStatusOptions = [
  { label: 'All users', value: 'all' as const },
  { label: 'Registered', value: 'registered' as const },
  { label: 'Capable, not registered', value: 'capable_not_registered' as const },
  { label: 'Not capable', value: 'not_capable' as const },
];

const mfaMethodOptions = computed(() => [
  { label: 'Any method', value: '' },
  ...mfaMethods.value.map((m) => ({ label: m, value: m })),
]);

const mfaActiveFilterCount = computed(() => {
  let n = 0;
  if (mfaStatus.value !== 'all') n++;
  if (mfaMethod.value) n++;
  if (mfaSearch.value) n++;
  return n;
});

async function loadMfa(): Promise<void> {
  if (directoryId.value === null) return;
  mfaLoading.value = true;
  mfaError.value = null;
  try {
    const r = await api.directories.entra.mfaRegistration(directoryId.value, {
      status: mfaStatus.value,
      ...(mfaMethod.value ? { method: mfaMethod.value } : {}),
      ...(mfaSearch.value ? { search: mfaSearch.value } : {}),
      page: mfaPage.value,
      pageSize: mfaPageSize.value,
    });
    mfaRows.value = r.rows;
    mfaTotal.value = r.total;
  } catch (err) {
    mfaError.value = err instanceof Error ? err.message : 'Failed to load MFA registration';
  } finally {
    mfaLoading.value = false;
  }
}

async function loadMfaMethods(): Promise<void> {
  if (directoryId.value === null) return;
  try {
    const r = await api.directories.entra.mfaRegistrationMethods(directoryId.value);
    mfaMethods.value = r.methods;
  } catch {
    // Non-fatal — dropdown just won't have options.
  }
}

watch(activeTab, (next) => {
  if (next === 'mfa') {
    if (mfaMethods.value.length === 0) void loadMfaMethods();
    if (mfaRows.value.length === 0 && !mfaLoading.value) void loadMfa();
  }
});

watch([mfaStatus, mfaMethod, mfaSearch], () => {
  mfaPage.value = 1;
  void loadMfa();
});

function onMfaPage(ev: DataTablePageEvent): void {
  mfaPage.value = ev.page + 1;
  mfaPageSize.value = ev.rows;
  void loadMfa();
}

function clearMfaFilters(): void {
  mfaStatus.value = 'all';
  mfaMethod.value = '';
  mfaSearchInput.value = '';
  mfaSearch.value = '';
}

function mfaStatusBadge(row: MfaRegistrationRow): { label: string; cls: string } {
  if (row.isMfaRegistered === true) return { label: 'registered', cls: 'badge-green' };
  if (row.isMfaCapable === true) return { label: 'capable, not registered', cls: 'badge-amber' };
  if (row.isMfaCapable === false) return { label: 'not capable', cls: 'badge-red' };
  return { label: 'unknown', cls: 'badge-muted' };
}

function openUserFromMfa(row: MfaRegistrationRow): void {
  void router.push({ name: 'user-detail', params: { id: row.userObjectGuid } });
}

const rows = ref<AuditEventRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(25);
const loading = ref(false);
const error = ref<string | null>(null);

const action = ref('');
const result = ref<string>('all');
const correlationId = ref('');

const resultOptions = [
  { label: 'All results', value: 'all' },
  { label: 'Success', value: 'success' },
  { label: 'Failure', value: 'failure' },
  { label: 'Denied', value: 'denied' },
];

let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const params: Record<string, string | number> = { page: page.value, pageSize: pageSize.value };
    if (action.value.trim()) params.action = action.value.trim();
    if (result.value !== 'all') params.result = result.value;
    if (correlationId.value.trim()) params.correlationId = correlationId.value.trim();
    const r = await api.audit.list(params);
    rows.value = r.rows;
    total.value = r.total;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load audit events';
  } finally {
    loading.value = false;
  }
}

function debouncedReload(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 250);
}

watch([action, correlationId], debouncedReload);
watch(result, () => {
  page.value = 1;
  void load();
});

function onPage(ev: DataTablePageEvent): void {
  page.value = ev.page + 1;
  pageSize.value = ev.rows;
  void load();
}

function resultBadge(r: string): string {
  if (r === 'success') return 'badge-green';
  if (r === 'failure' || r === 'denied') return 'badge-red';
  return 'badge-muted';
}

// Clicking a row opens the detail modal. We pass the full row through so the
// dialog can render every field (actor, request context, target, before/after,
// metadata) without a second round-trip.
const detailEvent = ref<AuditEventRow | null>(null);
const detailOpen = ref(false);

function openDetail(ev: DataTableRowClickEvent): void {
  detailEvent.value = ev.data as AuditEventRow;
  detailOpen.value = true;
}

onMounted(load);
</script>

<template>
  <div class="page-inner audit-page">
    <PageHeader title="Audit">
      <template #actions>
        <Button
          v-if="activeTab === 'log'"
          label="Refresh"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :loading="loading"
          @click="load"
        />
      </template>
    </PageHeader>

    <nav class="ds-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ active: activeTab === 'log' }"
        :aria-selected="activeTab === 'log'"
        @click="selectTab('log')"
      >
        <i class="pi pi-history" /> Local audit
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ active: activeTab === 'signins' }"
        :aria-selected="activeTab === 'signins'"
        @click="selectTab('signins')"
      >
        <i class="pi pi-sign-in" /> Sign-ins (Entra)
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ active: activeTab === 'mfa' }"
        :aria-selected="activeTab === 'mfa'"
        @click="selectTab('mfa')"
      >
        <i class="pi pi-shield" /> MFA registration
      </button>
    </nav>

    <div v-if="activeTab === 'log'" class="audit-log-section">
      <div class="filterbar">
        <div class="search">
          <i class="pi pi-search search-icon" />
          <input v-model="action" type="text" placeholder="Filter by action (e.g. user.unlock)" />
        </div>
        <Select
          v-model="result"
          :options="resultOptions"
          option-label="label"
          option-value="value"
        />
        <div class="search">
          <i class="pi pi-tag search-icon" />
          <input v-model="correlationId" type="text" placeholder="Correlation ID" />
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
        :rows-per-page-options="[25, 50, 100, 200]"
        data-key="id"
        class="audit-table"
        @page="onPage"
        @row-click="openDetail"
      >
        <template #empty>
          <EmptyState
            icon="pi pi-history"
            :title="
              action || result !== 'all' || correlationId
                ? 'No matching audit events'
                : 'No audit events yet'
            "
            :message="
              action || result !== 'all' || correlationId
                ? 'Try widening the filters.'
                : 'Activity from the API will appear here as it happens.'
            "
          >
            <template v-if="action || result !== 'all' || correlationId" #actions>
              <Button
                label="Clear filters"
                icon="pi pi-times"
                severity="secondary"
                outlined
                size="small"
                @click="
                  action = '';
                  result = 'all';
                  correlationId = '';
                  load();
                "
              />
            </template>
          </EmptyState>
        </template>
        <Column header="Time" :style="{ width: '170px' }">
          <template #body="{ data }">
            <div class="time-cell">
              <div class="mono">{{ fmtAbsolute(data.timestamp) }}</div>
              <div class="time-rel">{{ fmtRelative(data.timestamp) }}</div>
            </div>
          </template>
        </Column>
        <Column header="Actor" :style="{ minWidth: '200px' }">
          <template #body="{ data }">
            <div v-if="data.actorDisplayName" class="actor-cell">
              <Avatar
                :name="data.actorDisplayName"
                :seed="data.actorUserId ?? data.actorDisplayName"
                :size="22"
              />
              <span>{{ data.actorDisplayName }}</span>
            </div>
            <span v-else class="cell-muted">system</span>
          </template>
        </Column>
        <Column field="action" header="Action" :style="{ minWidth: '180px' }">
          <template #body="{ data }">
            <span class="mono action-cell">{{ data.action }}</span>
          </template>
        </Column>
        <Column header="Target" :style="{ minWidth: '200px' }">
          <template #body="{ data }">
            <span v-if="data.targetDn" class="dn-cell mono">{{ data.targetDn }}</span>
            <span v-else-if="data.targetType" class="cell-muted"
              >{{ data.targetType
              }}{{ data.targetId ? `:${data.targetId.slice(0, 8)}…` : '' }}</span
            >
            <span v-else class="cell-muted">—</span>
          </template>
        </Column>
        <Column header="Result" :style="{ width: '110px' }">
          <template #body="{ data }">
            <span class="badge" :class="resultBadge(data.result)">
              <span class="badge-dot" />
              {{ data.result }}
            </span>
          </template>
        </Column>
        <Column header="Error" :style="{ minWidth: '160px' }">
          <template #body="{ data }">
            <span v-if="data.errorCode" class="mono cell-muted">{{ data.errorCode }}</span>
            <span v-else class="cell-muted">—</span>
          </template>
        </Column>
      </DataTable>

      <AuditEventDialog v-model:visible="detailOpen" :event="detailEvent" />
    </div>

    <!-- Sign-ins tab — filterable view of cached Entra events. -->
    <div v-else-if="activeTab === 'signins'" class="audit-signin-section">
      <Message v-if="directoryId === null" severity="info" :closable="false">
        Sign-in events require an active directory session.
      </Message>

      <template v-else>
        <div class="signin-filterbar">
          <div class="signin-search">
            <i class="pi pi-search search-icon" />
            <input v-model="signInSearchInput" type="text" placeholder="Search user, app, IP…" />
          </div>
          <Select
            v-model="signInAppId"
            :options="signInAppOptions"
            option-label="label"
            option-value="value"
            placeholder="All applications"
            :pt="{ root: { style: 'min-width: 200px' } }"
          />
          <Select
            v-model="signInStatus"
            :options="signInStatusOptions"
            option-label="label"
            option-value="value"
          />
          <div class="signin-daterange">
            <DatePicker
              v-model="signInFrom"
              show-time
              hour-format="24"
              placeholder="From"
              :show-icon="true"
              icon-display="input"
              fluid
            />
            <span class="signin-daterange-sep">→</span>
            <DatePicker
              v-model="signInTo"
              show-time
              hour-format="24"
              placeholder="To"
              :show-icon="true"
              icon-display="input"
              fluid
            />
          </div>
          <Button
            v-if="signInActiveFilterCount > 0"
            label="Clear"
            icon="pi pi-times"
            severity="secondary"
            outlined
            size="small"
            @click="clearSignInFilters"
          />
          <Button
            label="Refresh"
            icon="pi pi-refresh"
            severity="secondary"
            outlined
            size="small"
            @click="signInRefreshKey++"
          />
        </div>

        <SignInEventsList
          :directory-id="directoryId"
          :app-id="signInAppId || undefined"
          :status="signInStatus"
          :from-iso="signInFromIso || undefined"
          :to-iso="signInToIso || undefined"
          :search="signInSearch || undefined"
          :refresh-key="signInRefreshKey"
          @select="onSignInSelect"
        />

        <SignInEventDetailDialog
          v-model:visible="signInDialogOpen"
          :directory-id="directoryId"
          :event-id="signInDialogEventId"
        />
      </template>
    </div>

    <!-- MFA registration tab — snapshot from user_entra_enrichment.
         The data is per-user (one row each) so a flat DataTable with
         clickable rows fits better than the timeline-style sign-ins
         list. -->
    <div v-else-if="activeTab === 'mfa'" class="audit-mfa-section">
      <Message v-if="directoryId === null" severity="info" :closable="false">
        MFA registration requires an active directory session.
      </Message>

      <template v-else>
        <div class="signin-filterbar">
          <div class="signin-search">
            <i class="pi pi-search search-icon" />
            <input v-model="mfaSearchInput" type="text" placeholder="Search user name or UPN…" />
          </div>
          <Select
            v-model="mfaStatus"
            :options="mfaStatusOptions"
            option-label="label"
            option-value="value"
          />
          <Select
            v-model="mfaMethod"
            :options="mfaMethodOptions"
            option-label="label"
            option-value="value"
            placeholder="Any method"
            :pt="{ root: { style: 'min-width: 220px' } }"
          />
          <Button
            v-if="mfaActiveFilterCount > 0"
            label="Clear"
            icon="pi pi-times"
            severity="secondary"
            outlined
            size="small"
            @click="clearMfaFilters"
          />
          <Button
            label="Refresh"
            icon="pi pi-refresh"
            severity="secondary"
            outlined
            size="small"
            :loading="mfaLoading"
            @click="loadMfa"
          />
        </div>

        <Message v-if="mfaError" severity="error" :closable="false">{{ mfaError }}</Message>

        <DataTable
          :value="mfaRows"
          :loading="mfaLoading"
          lazy
          paginator
          :rows="mfaPageSize"
          :total-records="mfaTotal"
          :first="(mfaPage - 1) * mfaPageSize"
          :rows-per-page-options="[25, 50, 100, 200]"
          data-key="userObjectGuid"
          class="mfa-table"
          @page="onMfaPage"
          @row-click="(ev) => openUserFromMfa(ev.data as MfaRegistrationRow)"
        >
          <template #empty>
            <EmptyState
              icon="pi pi-shield"
              :title="mfaActiveFilterCount > 0 ? 'No users match the filters' : 'No MFA data yet'"
              :message="
                mfaActiveFilterCount > 0
                  ? 'Try widening the filters or running entra.mfa.registration.'
                  : 'Enable MFA registration in Settings → Integrations and run the entra.mfa.registration task to populate this view.'
              "
            />
          </template>
          <Column header="User" :style="{ minWidth: '260px' }">
            <template #body="{ data }">
              <div class="actor-cell">
                <Avatar
                  :name="data.userDisplayName ?? data.samAccountName"
                  :seed="data.samAccountName ?? data.userObjectGuid"
                  :photo-url="`/api/directories/${directoryId}/users/${data.userObjectGuid}/photo`"
                  :size="28"
                />
                <div class="user-cell-stack">
                  <div class="user-name">
                    {{ data.userDisplayName ?? data.samAccountName ?? '—' }}
                  </div>
                  <div class="user-meta mono">
                    {{ data.userPrincipalName ?? data.samAccountName ?? '' }}
                  </div>
                </div>
              </div>
            </template>
          </Column>
          <Column header="Department" :style="{ minWidth: '160px' }">
            <template #body="{ data }">
              <span v-if="data.department">{{ data.department }}</span>
              <span v-else class="cell-muted">—</span>
            </template>
          </Column>
          <Column header="Status" :style="{ width: '210px' }">
            <template #body="{ data }">
              <span class="badge" :class="mfaStatusBadge(data).cls">
                <span class="badge-dot" />
                {{ mfaStatusBadge(data).label }}
              </span>
            </template>
          </Column>
          <Column header="Methods" :style="{ minWidth: '260px' }">
            <template #body="{ data }">
              <div v-if="data.methods.length > 0" class="mfa-method-tags">
                <span
                  v-for="m in data.methods"
                  :key="m"
                  class="mfa-method-tag mono"
                  :class="{ 'mfa-method-default': m === data.defaultMethod }"
                  :title="m === data.defaultMethod ? 'Default method' : undefined"
                >
                  <i v-if="m === data.defaultMethod" class="pi pi-star-fill" />
                  {{ m }}
                </span>
              </div>
              <span v-else class="cell-muted">—</span>
            </template>
          </Column>
          <Column header="Passwordless" :style="{ width: '120px' }">
            <template #body="{ data }">
              <span v-if="data.isPasswordlessCapable === true" class="badge badge-green">
                <span class="badge-dot" /> yes
              </span>
              <span v-else-if="data.isPasswordlessCapable === false" class="cell-muted">no</span>
              <span v-else class="cell-muted">—</span>
            </template>
          </Column>
          <Column header="Last refreshed" :style="{ width: '180px' }">
            <template #body="{ data }">
              <div v-if="data.fetchedAt" class="time-cell">
                <div class="mono">{{ fmtAbsolute(data.fetchedAt) }}</div>
                <div class="time-rel">{{ fmtRelative(data.fetchedAt) }}</div>
              </div>
              <span v-else class="cell-muted">—</span>
            </template>
          </Column>
        </DataTable>
      </template>
    </div>
  </div>
</template>

<style scoped>
.audit-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Tab strip mirrors SettingsView for visual consistency. */
.ds-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.ds-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 0;
  padding: 9px 14px;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  border-radius: 6px 6px 0 0;
  font-family: var(--font-sans);
}

.ds-tab:hover {
  color: var(--text);
}

.ds-tab.active {
  color: var(--text);
}

.ds-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}

.audit-log-section,
.audit-signin-section,
.audit-mfa-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* MFA tab tag styles. The default method gets a filled star + accent
   color so an operator can spot the per-user "primary" at a glance. */
.mfa-method-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mfa-method-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 11px;
  color: var(--text-2);
}

.mfa-method-tag.mfa-method-default {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: color-mix(in oklab, var(--accent) 32%, transparent);
}

.mfa-method-tag .pi-star-fill {
  font-size: 9px;
}

/* User cell layout in the MFA table — avatar + display name + UPN
   stacked. Mirrors UserSearchView's user column. */
.user-cell-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.user-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-meta {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.mfa-table .p-datatable-tbody > tr) {
  cursor: pointer;
}

/* Sign-ins filter bar. Wraps to multiple lines on narrow viewports. */
.signin-filterbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 0;
}

.signin-search {
  position: relative;
  flex: 1;
  min-width: 220px;
}

.signin-search input {
  width: 100%;
  padding: 7px 10px 7px 30px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-sans);
}

.signin-search input:focus {
  outline: none;
  border-color: var(--accent);
}

.signin-search .search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  font-size: 12px;
}

.signin-daterange {
  display: flex;
  align-items: center;
  gap: 6px;
}

.signin-daterange-sep {
  color: var(--text-3);
  font-size: 12px;
}

.time-cell {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  line-height: 1.3;
}

.time-rel {
  color: var(--text-3);
  font-size: 11px;
}

.actor-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-cell {
  font-size: 12px;
  color: var(--text);
}

.dn-cell {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
  display: inline-block;
}

.cell-muted {
  color: var(--text-3);
}

:deep(.audit-table .p-datatable-tbody > tr) {
  cursor: pointer;
}
</style>
