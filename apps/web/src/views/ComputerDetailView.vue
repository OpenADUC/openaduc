<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { useComputerRecord } from '../design/composables/useDirectoryRecords.js';
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import type { ComputerDetail, ComputerWriteBlock } from '@openaduc/shared';
import Card from '../design/primitives/Card.vue';
import Avatar from '../design/primitives/Avatar.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import AppToast from '../design/feedback/AppToast.vue';
import ConfirmDialog from '../design/feedback/ConfirmDialog.vue';
import MoveToOuDialog from '../design/feedback/MoveToOuDialog.vue';
import { undoable } from '../design/feedback/undoToast.js';
import { computerName, fmtRelative } from '../design/lib/format.js';
import { placeFailure } from '../design/lib/failurePlacement.js';
import { useAccountActions } from '../design/composables/useAccountActions.js';
import { useComputerReset } from '../design/composables/useComputerReset.js';
import ObjectPageLayout from './_detail/ObjectPageLayout.vue';
import type { ObjectAction, ObjectPageTab } from './_detail/objectPage';
import type { ActionFailure } from '../design/lib/actionFailure.js';
import { useRecordCrumb } from '../design/layout/recordCrumb.js';
import { useMoveDialog } from './_detail/useMoveDialog';

const props = defineProps<{ id: string }>();
const router = useRouter();
const toast = useToast();

const {
  record: computer,
  loading,
  error,
  load,
  refreshing,
  refresh,
} = useComputerRecord({
  id: () => props.id,
});
useRecordCrumb(
  () => props.id,
  () => computer.value?.name ?? computer.value?.distinguishedName,
);

function refreshFromAd(): Promise<void> {
  // GET live-refreshes against AD, so a reload is a sync of this one object.
  return refresh(toast, 'Refreshed');
}

watch(() => props.id, load);
onMounted(load);

const groupCount = computed(() => computer.value?.groupMemberships.length ?? 0);

type TabId = 'overview' | 'groups';
const tabs = computed<ObjectPageTab<TabId>[]>(() => [
  { id: 'overview', label: 'Overview', icon: 'pi-th-large', visible: true, iconOnly: true },
  { id: 'groups', label: 'Groups', icon: 'pi-users', count: groupCount.value, visible: true },
]);

function openGroup(g: ComputerDetail['groupMemberships'][number]): void {
  if (!g.id) return;
  void router.push({ name: 'group-detail', params: { id: g.id } });
}

// ---- Actions ---------------------------------------------------------------
// Disable, enable and move act at once and offer Undo; a reset can't be
// undone, so it asks first.

const {
  runningOn: accountActionOn,
  run: runAccountAction,
  failure: accountFailure,
  retry: retryAccountAction,
  dismiss: dismissAccountFailure,
} = useAccountActions<ComputerDetail, 'computer'>({
  kind: 'computer',
  onDone: async (action, c, offer) => {
    const done = action === 'disable' ? 'Disabled' : 'Enabled';
    toast.add(
      undoable({ severity: 'success', summary: `${done} ${computerName(c)}`, life: 3000 }, offer),
    );
    await load();
  },
});

const {
  pending: resetPending,
  ask: askReset,
  confirm: confirmReset,
  cancel: cancelReset,
  runningOn: resetRunningOn,
  failure: resetFailure,
  retry: retryReset,
  dismiss: dismissResetFailure,
} = useComputerReset<ComputerDetail>({
  onReset: async (c) => {
    toast.add({
      severity: 'success',
      summary: `Reset the account of ${computerName(c)}`,
      detail: 'Rejoin it to the domain under the same name.',
      life: 5000,
    });
    await load();
  },
});

const {
  move: mover,
  open: moveDialogOpen,
  show: openMoveDialog,
  close: closeMoveDialog,
  dialogFailure: moveDialogFailure,
  pageFailure: movePageFailure,
  submitting: moveSubmitting,
} = useMoveDialog({ kind: 'computer', id: () => props.id, onMoved: () => load() });

const { onPage: accountPageFailure } = placeFailure(accountFailure, {
  belongsHere: (f) => f.op.account.id === props.id,
});
const { onPage: resetPageFailure } = placeFailure(resetFailure, {
  belongsHere: (f) => f.op.computer.id === props.id,
});

const actionFailure = computed<ActionFailure | null>(() => {
  const account = accountPageFailure.value;
  if (account) {
    const { action, account: c } = account.op;
    return {
      summary: `Couldn’t ${action} ${computerName(c)}`,
      message: account.message,
      retry: retryAccountAction,
      dismiss: dismissAccountFailure,
    };
  }
  const reset = resetPageFailure.value;
  if (reset) {
    return {
      summary: `Couldn’t reset the account of ${computerName(reset.op.computer)}`,
      message: reset.message,
      retry: retryReset,
      dismiss: dismissResetFailure,
    };
  }
  return movePageFailure.value;
});

const accountActionRunning = computed(() => accountActionOn(props.id));
const busy = computed(
  () => accountActionRunning.value !== null || resetRunningOn(props.id) || moveSubmitting.value,
);

const actions = computed<ObjectAction[]>(() => {
  const c = computer.value;
  // Disabling, resetting or moving a domain controller can take the domain
  // down; the server refuses them too. While the record loads nothing is
  // available, but the list lets the layout hold the Actions button's place.
  const writable = c?.writeBlock === null;
  return [
    c?.enabled !== false
      ? {
          label: accountActionRunning.value === 'disable' ? 'Disabling…' : 'Disable account',
          icon: 'pi-ban',
          capability: 'write:computer.enableDisable',
          available: writable,
          danger: true,
          disabled: busy.value,
          run: () => c && runAccountAction('disable', c),
        }
      : {
          label: accountActionRunning.value === 'enable' ? 'Enabling…' : 'Enable account',
          icon: 'pi-check',
          capability: 'write:computer.enableDisable',
          disabled: busy.value,
          run: () => runAccountAction('enable', c),
        },
    {
      label: c && resetRunningOn(c.id) ? 'Resetting…' : 'Reset account…',
      icon: 'pi-refresh',
      capability: 'write:computer.resetAccount',
      available: writable,
      danger: true,
      disabled: busy.value,
      run: () => c && askReset(c),
    },
    {
      label: moveSubmitting.value ? 'Moving…' : 'Move to OU…',
      icon: 'pi-folder-open',
      capability: 'write:computer.move',
      available: writable,
      disabled: busy.value,
      run: openMoveDialog,
    },
  ];
});

const WRITE_BLOCK: Record<ComputerWriteBlock, { label: string; title: string }> = {
  domain_controller: {
    label: 'domain controller',
    title: 'OpenADUC won’t disable, reset or move a domain controller.',
  },
  read_only_domain_controller: {
    label: 'read-only domain controller',
    title: 'OpenADUC won’t disable, reset or move a domain controller.',
  },
  critical_system_object: {
    label: 'critical',
    title:
      'AD marks this computer as a critical system object, so OpenADUC won’t disable, reset or move it.',
  },
};

function openManagedBy(): void {
  if (!computer.value?.managedBy?.id) return;
  void router.push({
    name: 'user-detail',
    params: { id: computer.value.managedBy.id },
  });
}
</script>

<template>
  <AppToast />
  <div class="page-inner computer-detail-page">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <ObjectPageLayout
      v-if="computer || loading"
      kind="computer"
      :loading="!computer"
      :skeleton="{ cards: 1 }"
      :name="computer?.name ?? computer?.distinguishedName ?? ''"
      :avatar="{
        name: computer?.name ?? computer?.distinguishedName ?? null,
        seed: computer?.samAccountName ?? computer?.distinguishedName ?? null,
        shape: 'rounded',
        icon: 'pi-desktop',
      }"
      :subtitle="computer?.description ?? null"
      :identifier="computer?.dnsHostName ? { text: computer.dnsHostName } : null"
      :dn="computer?.distinguishedName ?? ''"
      :tabs="tabs"
      fallback-tab="overview"
      :actions="actions"
      :actions-busy="busy"
      :action-failure="actionFailure"
      :refreshing="refreshing"
      :cached-at="computer?.freshness.cachedAt ?? null"
      @refresh="refreshFromAd"
    >
      <template v-if="computer" #badges>
        <span v-if="computer.enabled" class="badge badge-green badge-lg" title="enabled">
          <i class="pi pi-check-circle" /> enabled
        </span>
        <span v-else class="badge badge-red badge-lg" title="disabled">
          <i class="pi pi-ban" /> disabled
        </span>
        <span
          v-if="computer.writeBlock"
          class="badge badge-violet badge-lg"
          :title="WRITE_BLOCK[computer.writeBlock].title"
        >
          <i class="pi pi-shield" /> {{ WRITE_BLOCK[computer.writeBlock].label }}
        </span>
        <span
          v-if="computer.freshness.isStale"
          class="badge badge-amber badge-lg"
          title="cache row marked stale"
        >
          <i class="pi pi-clock" /> stale
        </span>
      </template>

      <template v-if="computer" #default="{ tab: activeTab }">
        <Card v-if="activeTab === 'overview'" title="Identity" sub="Read from Active Directory">
          <dl class="kv-grid">
            <dt>Name</dt>
            <dd>{{ computer.name ?? '—' }}</dd>
            <dt>Pre-Windows 2000 name</dt>
            <dd class="mono">{{ computer.samAccountName ?? '—' }}</dd>
            <dt>DNS hostname</dt>
            <dd class="mono">{{ computer.dnsHostName ?? '—' }}</dd>
            <dt>Operating system</dt>
            <dd>
              <template v-if="computer.operatingSystem">
                {{ computer.operatingSystem }}
                <span v-if="computer.operatingSystemVersion" class="kv-meta mono">
                  {{ computer.operatingSystemVersion }}
                </span>
              </template>
              <template v-else>—</template>
            </dd>
            <dt>Description</dt>
            <dd>{{ computer.description ?? '—' }}</dd>
            <dt>Managed by</dt>
            <dd>
              <template v-if="computer.managedBy">
                <a
                  v-if="computer.managedBy.id"
                  href="#"
                  class="link"
                  @click.prevent="openManagedBy"
                  >{{ computer.managedBy.displayName ?? computer.managedBy.distinguishedName }}</a
                >
                <span v-else class="mono">{{ computer.managedBy.distinguishedName }}</span>
              </template>
              <template v-else>—</template>
            </dd>
            <dt>Last logon</dt>
            <dd>
              <span v-if="computer.lastLogonAt" :title="computer.lastLogonAt">
                {{ fmtRelative(computer.lastLogonAt) }}
              </span>
              <span v-else class="cell-muted">—</span>
              <!-- AD's lastLogonTimestamp replicates lazily (every 9–14 days
                 by default), so this value can lag actual logons. -->
              <span class="kv-meta">approximate</span>
            </dd>
            <dt>Password last set</dt>
            <dd>
              <span v-if="computer.passwordLastSetAt" :title="computer.passwordLastSetAt">
                {{ fmtRelative(computer.passwordLastSetAt) }}
              </span>
              <span v-else class="cell-muted">—</span>
            </dd>
            <dt>Created</dt>
            <dd>
              <span v-if="computer.createdAtSource" :title="computer.createdAtSource">
                {{ fmtRelative(computer.createdAtSource) }}
              </span>
              <span v-else class="cell-muted">—</span>
            </dd>
            <dt>Modified</dt>
            <dd>
              <span v-if="computer.modifiedAtSource" :title="computer.modifiedAtSource">
                {{ fmtRelative(computer.modifiedAtSource) }}
              </span>
              <span v-else class="cell-muted">—</span>
            </dd>
          </dl>
        </Card>

        <Card
          v-else-if="activeTab === 'groups'"
          :title="`Group memberships (${groupCount})`"
          sub="Direct memberOf entries from the live read"
        >
          <EmptyState
            v-if="groupCount === 0"
            icon="pi pi-objects-column"
            title="Not a member of any groups"
            message="Computers join groups for GPO targeting and resource ACLs. None set on this account."
          />
          <ul v-else class="group-list">
            <li
              v-for="g in computer.groupMemberships"
              :key="g.distinguishedName"
              class="group-row"
              :class="{ clickable: !!g.id }"
              @click="g.id && openGroup(g)"
            >
              <Avatar
                :name="g.name ?? g.distinguishedName"
                :seed="g.distinguishedName"
                :size="28"
                shape="rounded"
              />
              <div class="group-stack">
                <div class="group-name">{{ g.name ?? g.distinguishedName }}</div>
                <div v-if="g.name" class="group-meta mono">{{ g.distinguishedName }}</div>
              </div>
              <span v-if="!g.id" class="badge badge-muted mono" title="not in cache yet">
                uncached
              </span>
            </li>
          </ul>
        </Card>
      </template>
    </ObjectPageLayout>

    <ConfirmDialog
      v-if="computer"
      :visible="resetPending !== null"
      :title="`Reset the account of ${computerName(computer)}?`"
      :message="`${computerName(computer)} can’t sign in to the domain until it rejoins under the same name. This can’t be undone.`"
      confirm-label="Reset account"
      severity="danger"
      @update:visible="(v) => !v && cancelReset()"
      @cancel="cancelReset"
      @confirm="confirmReset"
    />
    <MoveToOuDialog
      v-if="computer"
      :visible="moveDialogOpen"
      :move="mover"
      kind="computer"
      :name="computerName(computer)"
      :failure="moveDialogFailure"
      @close="closeMoveDialog"
    />
  </div>
</template>

<style scoped>
.computer-detail-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kv-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 18px;
  row-gap: 8px;
  margin: 0;
}

.kv-grid dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
  align-self: center;
}

.kv-grid dd {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.kv-meta {
  font-size: 11px;
  color: var(--text-3);
}

.cell-muted {
  color: var(--text-3);
}

.link {
  color: var(--accent);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
}

.group-row.clickable {
  cursor: pointer;
}

.group-row.clickable:hover {
  background: var(--hover);
}

.group-mark {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: 6px;
  background: var(--violet-soft);
  color: var(--violet);
  display: grid;
  place-items: center;
  font-size: 12px;
}

.group-stack {
  flex: 1;
  min-width: 0;
}

.group-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
