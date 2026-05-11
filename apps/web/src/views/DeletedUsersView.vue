<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import DataTable, { type DataTablePageEvent } from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import type { DeletedUserSummary, RecycleBinStatus } from '@openaduc/shared';
import { useAuthStore } from '../stores/auth.js';
import PageHeader from '../design/primitives/PageHeader.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import { fmtRelative } from '../design/lib/format.js';

const router = useRouter();
const auth = useAuthStore();
const toast = useToast();

const rows = ref<DeletedUserSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(25);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
const recycleBin = ref<RecycleBinStatus | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | undefined;

const canRestore = computed(() => auth.hasCapability('write:user.restore'));

async function load(): Promise<void> {
  // Step-up gates the API; bail early instead of provoking a 403 the
  // moment the user lands on the page without edit mode on.
  if (!auth.editMode) return;
  loading.value = true;
  error.value = null;
  try {
    const params: Record<string, string | number> = {
      page: page.value,
      pageSize: pageSize.value,
    };
    if (search.value.trim()) params.q = search.value.trim();
    const resp = await api.deletedUsers.search(params);
    rows.value = resp.rows;
    total.value = resp.total;
    recycleBin.value = resp.recycleBin;
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 403
        ? 'Your account does not have permission to view deleted users (or your editing session expired).'
        : err instanceof Error
          ? err.message
          : 'Failed to load deleted users';
  } finally {
    loading.value = false;
  }
}

// Re-load when edit mode flips on. When it flips off (manual or TTL
// expiry), drop the data so the empty surface matches the locked-out
// state — the operator shouldn't keep seeing the deleted-users list
// after their elevated session ended.
watch(
  () => auth.editMode,
  (now, prev) => {
    if (now && !prev) {
      void load();
    } else if (!now && prev) {
      rows.value = [];
      total.value = 0;
      recycleBin.value = null;
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

// ---- Restore flow ----------------------------------------------------------
// Single-row restore via a confirmation dialog. The actual write requires
// edit mode (step-up) — the dialog Restore button is disabled until the
// operator turns on edit mode via the topbar toggle, with a hint explaining
// why. v1 doesn't expose target-OU override; we rely on lastKnownParent.

const pending = ref<DeletedUserSummary | null>(null);
const dialogOpen = ref(false);
const restoring = ref(false);

function askRestore(row: DeletedUserSummary): void {
  pending.value = row;
  dialogOpen.value = true;
}

async function confirmRestore(): Promise<void> {
  const row = pending.value;
  if (!row) return;
  restoring.value = true;
  try {
    const resp = await api.deletedUsers.restore(row.id, {});
    toast.add({
      severity: 'success',
      summary: 'User restored',
      detail: row.displayName ?? row.cn ?? row.samAccountName ?? row.id,
      life: 4000,
    });
    dialogOpen.value = false;
    pending.value = null;
    // The user is back in the live cache now — drop them from the deleted
    // listing without a full reload. We still refetch in the background to
    // pick up the new total.
    rows.value = rows.value.filter((r) => r.id !== row.id);
    total.value = Math.max(0, total.value - 1);
    await router.push({ name: 'user-detail', params: { id: row.id } }).catch(() => undefined);
    void load();
    void resp;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = confirmRestore;
      return;
    }
    const message =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Restore failed';
    toast.add({ severity: 'error', summary: 'Restore failed', detail: message, life: 8000 });
  } finally {
    restoring.value = false;
  }
}

// Auto-load only when the operator already has edit mode on (e.g. they
// turned it on elsewhere and navigated here). When off, the template
// renders the gate panel and waits for the watch above to fire.
onMounted(() => {
  if (auth.editMode) void load();
});

// ---- Recycle-bin banner content -------------------------------------------
// Three states the banner can be in:
//   - enabled: green, restored users keep group memberships and attributes.
//   - disabled (probe succeeded): amber, restores succeed but in tombstone
//     mode — group memberships gone, most attributes stripped.
//   - probe failed (e.g. operator can't read Optional Features): info,
//     "could not verify" — don't claim disabled because the probe couldn't
//     reach the source of truth.
const probeFailed = computed(
  () =>
    recycleBin.value !== null &&
    !recycleBin.value.recycleBinEnabled &&
    recycleBin.value.message !== null,
);

const bannerSeverity = computed<'success' | 'warn' | 'info'>(() => {
  if (!recycleBin.value) return 'info';
  if (probeFailed.value) return 'info';
  return recycleBin.value.recycleBinEnabled ? 'success' : 'warn';
});

const bannerTitle = computed(() => {
  if (!recycleBin.value) return 'Checking Recycle Bin status…';
  if (probeFailed.value) return 'Could not verify Recycle Bin status';
  return recycleBin.value.recycleBinEnabled
    ? 'AD Recycle Bin is enabled'
    : 'AD Recycle Bin is not enabled';
});

const bannerBody = computed(() => {
  if (!recycleBin.value) return '';
  if (probeFailed.value) {
    return `Your account may not have read on the configuration partition. Restores will still succeed if AD permits them, but we can't tell you in advance whether they'll come back in full Recycle Bin form or tombstone form. (probe note: ${recycleBin.value.message})`;
  }
  if (recycleBin.value.recycleBinEnabled) {
    return 'Restored users keep their group memberships and most attributes.';
  }
  return 'Restores succeed in tombstone mode, but group memberships and most attributes are not preserved. The Recycle Bin Optional Feature is a one-way switch enabled at the domain level — ask a Domain Admin to enable it via Active Directory Administrative Center.';
});
</script>

<template>
  <Toast />
  <div class="page-inner deleted-users-page">
    <PageHeader title="Deleted users" :sub="`${total.toLocaleString()} pending restore`">
      <template #actions>
        <Button
          label="Back to users"
          icon="pi pi-arrow-left"
          severity="secondary"
          outlined
          @click="router.push({ name: 'user-search' })"
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

    <!-- Edit-mode gate. The list and restore both bind to AD as the
         operator (no service-account elevation), so we need the cached
         step-up password to be present. When not elevated, the entire
         working surface is replaced with a clear hint pointing at the
         topbar toggle — no half-loaded UI, no confusing 403s. -->
    <div v-if="!auth.editMode" class="gate-panel">
      <i class="pi pi-lock gate-icon" />
      <div class="gate-stack">
        <strong>Editing required to view deleted users</strong>
        <p class="gate-body">
          The deleted-users list reads Active Directory as your account, not the service account, so
          what you see and what you can restore is governed by your AD permissions. Authenticate to
          load the page.
        </p>
        <div>
          <Button
            label="Authenticate"
            icon="pi pi-key"
            size="small"
            @click="auth.requestStepUp()"
          />
        </div>
      </div>
    </div>

    <template v-else>
      <Message :severity="bannerSeverity" :closable="false">
        <div class="banner-stack">
          <strong>{{ bannerTitle }}</strong>
          <span class="banner-body">{{ bannerBody }}</span>
        </div>
      </Message>

      <div class="filterbar">
        <div class="search">
          <i class="pi pi-search search-icon" />
          <input
            v-model="search"
            type="text"
            placeholder="Search by name, username, UPN, email…"
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
        class="deleted-users-table"
        @page="onPage"
      >
        <template #empty>
          <EmptyState
            icon="pi pi-trash"
            :title="search ? 'No deleted users match' : 'Recycle Bin is empty'"
            :message="
              search
                ? 'Try a different search term.'
                : 'Deleted accounts will appear here while they are still recoverable.'
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
        <!-- Restore as the FIRST column on the right side keeps the
           primary action visible without horizontal scrolling. The
           previous layout (5 columns including a redundant Email field)
           pushed Restore off-screen on smaller viewports. Email is
           dropped — UPN under the name covers the same role. -->
        <Column header="Name" :style="{ minWidth: '220px' }">
          <template #body="{ data }">
            <div class="user-cell">
              <div class="user-name">
                {{ data.displayName ?? data.cn ?? data.samAccountName ?? '—' }}
              </div>
              <div class="user-meta">
                {{ data.userPrincipalName ?? data.email ?? data.samAccountName ?? '—' }}
              </div>
            </div>
          </template>
        </Column>
        <Column header="Last known parent" :style="{ width: '40%', maxWidth: '0' }">
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
        <Column header="" :style="{ width: '110px' }" class="action-col">
          <template #body="{ data }">
            <Button
              v-if="canRestore"
              label="Restore"
              icon="pi pi-undo"
              size="small"
              severity="primary"
              :disabled="restoring || data.recycled"
              :title="data.recycled ? 'Recycled entries cannot be restored' : undefined"
              @click="auth.requireEdit(() => askRestore(data))"
            />
          </template>
        </Column>
      </DataTable>
    </template>

    <Dialog
      v-model:visible="dialogOpen"
      :header="`Restore ${pending?.displayName ?? pending?.cn ?? pending?.samAccountName ?? 'user'}`"
      modal
      :style="{ width: '480px' }"
    >
      <div v-if="pending" class="confirm-stack">
        <p>
          This will reanimate the deleted account in Active Directory. The user will be restored to
          its last known parent OU.
        </p>
        <dl class="confirm-grid">
          <dt>Identifier</dt>
          <dd class="mono">
            {{ pending.samAccountName ?? pending.userPrincipalName ?? pending.id }}
          </dd>
          <dt>Restore to</dt>
          <dd class="mono">{{ pending.lastKnownParent ?? '— (no parent recorded)' }}</dd>
        </dl>
        <Message v-if="!pending.lastKnownParent" severity="warn" :closable="false">
          Active Directory did not preserve <code>lastKnownParent</code> for this entry. Restore
          will likely fail until support for an explicit target OU is added.
        </Message>
        <Message
          v-if="recycleBin && !recycleBin.recycleBinEnabled"
          severity="warn"
          :closable="false"
        >
          The Recycle Bin is not enabled — restored users come back in tombstone form (no group
          memberships, sparse attributes).
        </Message>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          severity="secondary"
          text
          :disabled="restoring"
          @click="dialogOpen = false"
        />
        <Button
          label="Restore user"
          icon="pi pi-undo"
          :loading="restoring"
          :disabled="!pending"
          @click="auth.requireEdit(confirmRestore)"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.deleted-users-page {
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

.user-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}

.user-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  /* The column uses width:40% + maxWidth:0 (a CSS table layout trick)
     so the cell shrinks to fit available space and the ellipsis kicks
     in. Hover the cell to see the full DN via the title attribute. */
  width: 100%;
}

/* Right-align the action column so the Restore button hugs the right
   edge and stays visible at the natural end of the row. */
:deep(.action-col) {
  text-align: right;
}

.confirm-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.confirm-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 16px;
  row-gap: 6px;
  margin: 0;
}

.confirm-grid dt {
  font-size: 12px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.confirm-grid dd {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
}
</style>
