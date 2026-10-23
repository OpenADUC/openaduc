<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { useGroupRecord } from '../design/composables/useDirectoryRecords.js';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import DataTable, { type DataTableRowClickEvent } from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { useAuthStore } from '../stores/auth.js';
import type { GroupMember } from '@openaduc/shared';
import Card from '../design/primitives/Card.vue';
import StatusBadge from '../design/primitives/StatusBadge.vue';
import Avatar from '../design/primitives/Avatar.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import AppToast from '../design/feedback/AppToast.vue';
import InlineFailure from '../design/feedback/InlineFailure.vue';
import DeleteGroupDialog from '../design/feedback/DeleteGroupDialog.vue';
import { undoable } from '../design/feedback/undoToast.js';
import ObjectPageLayout from './_detail/ObjectPageLayout.vue';
import type { ObjectAction, ObjectLink, ObjectPageTab } from './_detail/objectPage';
import { useRecordCrumb } from '../design/layout/recordCrumb.js';
import {
  memberLabel,
  membershipChangeText,
  membershipDoneText,
  membershipOf,
  useGroupMembership,
} from '../design/composables/useGroupMembership.js';
import {
  useGroupMemberSearch,
  type MemberCandidate,
} from '../design/composables/useGroupMemberSearch.js';
import { placeFailure } from '../design/lib/failurePlacement.js';

const props = defineProps<{ id: string }>();
const router = useRouter();
const auth = useAuthStore();
const toast = useToast();

// Member-add dialog state — opens on "Add member", searches users and
// groups, and adds the selected one the way its own page would.
const addOpen = ref(false);
const addSelected = ref<MemberCandidate | null>(null);

const {
  pending,
  add: addMembership,
  remove: removeMembership,
  failure,
  retry,
  dismiss,
} = useGroupMembership({
  onChanged: async (change, m, offer) => {
    if (change === 'add') closeAdd();
    toast.add(
      undoable({ severity: 'success', summary: membershipDoneText(change, m), life: 3000 }, offer),
    );
    await load();
  },
});

// A failed add shows in the add dialog while it's open; any other failed
// change (a remove, an Undo) shows on the Members tab.
const { inDialog: addFailure, onPage: pageFailure } = placeFailure(failure, {
  belongsHere: (f) => f.op.membership.groupId === props.id,
  dialog: { open: () => addOpen.value, made: (f) => f.op.change === 'add' && !f.undo },
});
const membersFailure = computed(() => {
  const f = pageFailure.value;
  if (!f) return null;
  return {
    summary: `Couldn’t ${membershipChangeText(f.op.change, f.op.membership)}`,
    message: f.message,
  };
});
const adding = computed(() => pending.value?.change === 'add');
const removingMemberId = computed(() =>
  pending.value?.change === 'remove' ? pending.value.membership.memberId : null,
);

const canManage = computed(() => auth.hasCapability('write:group.membership'));
const memberCount = computed(() => group.value?.members.length ?? 0);

const {
  record: group,
  loading,
  error,
  load,
  refreshing,
  refresh,
} = useGroupRecord({
  id: () => props.id,
});
const {
  query: addQuery,
  results: addResults,
  searching: addLoading,
  searchError: addSearchError,
  reset: resetAddSearch,
} = useGroupMemberSearch(() => group.value);
useRecordCrumb(
  () => props.id,
  () => group.value?.name ?? group.value?.distinguishedName,
);

function refreshFromAd(): Promise<void> {
  // GET live-refreshes against AD, so a reload is a sync of this one object.
  return refresh(toast, 'Refreshed');
}

watch(() => props.id, load);
// Another group's page reuses this one; what failed on the last one is moot.
watch(() => props.id, dismiss);
onMounted(load);

// ---- Add member -----------------------------------------------------------

function openAdd(): void {
  addOpen.value = true;
  resetAddSearch();
  addSelected.value = null;
}

function confirmAdd(): void {
  const c = addSelected.value;
  if (!c || !group.value) return;
  addMembership(membershipOf(c, group.value));
}

function closeAdd(): void {
  if (addFailure.value) dismiss();
  addOpen.value = false;
  addSelected.value = null;
  resetAddSearch();
}

function startRemove(member: GroupMember): void {
  if (group.value) removeMembership(membershipOf(member, group.value));
}

function memberRoute(m: GroupMember) {
  return { name: m.kind === 'user' ? 'user-detail' : 'group-detail', params: { id: m.id } };
}

function openMember(ev: DataTableRowClickEvent): void {
  void router.push(memberRoute(ev.data as GroupMember));
}

/** The line under a member's name: a user's UPN, a group's pre-Windows 2000 name. */
function accountOf(m: GroupMember | MemberCandidate): string {
  return m.kind === 'user'
    ? (m.userPrincipalName ?? m.samAccountName)
    : (m.samAccountName ?? m.distinguishedName);
}

const avatarShape = (m: GroupMember | MemberCandidate) =>
  m.kind === 'group' ? ('rounded' as const) : ('circle' as const);

// ---- Header and tabs -------------------------------------------------------

// The email when there is one, else the pre-Windows 2000 name.
const identifier = computed(() => {
  const g = group.value;
  if (g?.email) return { text: g.email, copyLabel: 'email' };
  return g?.samAccountName ? { text: g.samAccountName } : null;
});

const links = computed<ObjectLink[]>(() =>
  group.value?.email
    ? [
        {
          label: 'Email',
          icon: 'pi-envelope',
          href: `mailto:${group.value.email}`,
          title: 'Send email',
        },
      ]
    : [],
);

type TabId = 'overview' | 'members';
const tabs = computed<ObjectPageTab<TabId>[]>(() => [
  { id: 'overview', label: 'Overview', icon: 'pi-th-large', visible: true, iconOnly: true },
  { id: 'members', label: 'Members', icon: 'pi-users', count: memberCount.value, visible: true },
]);

const actions = computed<ObjectAction[]>(() => [
  {
    label: 'Add member…',
    icon: 'pi-user-plus',
    capability: 'write:group.membership',
    disabled: pending.value !== null,
    run: openAdd,
  },
  {
    label: 'Delete…',
    icon: 'pi-trash',
    capability: 'write:group.delete',
    danger: true,
    disabled: pending.value !== null,
    run: () => {
      deleteOpen.value = true;
    },
  },
]);

// ---- Delete ------------------------------------------------------------------

const deleteOpen = ref(false);

async function onDeleted(): Promise<void> {
  const name = group.value?.name ?? group.value?.samAccountName ?? 'The group';
  deleteOpen.value = false;
  // The group list shows the toast, so it waits until the list is there.
  await router.push({ name: 'group-search' });
  toast.add({
    severity: 'success',
    summary: 'Group deleted',
    detail: `${name} was deleted.`,
    life: 5000,
  });
}

const membersTop = computed(() => (group.value?.members ?? []).slice(0, 5));
</script>

<template>
  <AppToast />
  <div class="page-inner group-detail-page">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <ObjectPageLayout
      v-if="group || loading"
      kind="group"
      :loading="!group"
      :skeleton="{ subtitle: true }"
      :name="group?.name ?? group?.distinguishedName ?? ''"
      :avatar="{
        name: group?.name ?? group?.samAccountName ?? null,
        seed: group?.samAccountName ?? group?.distinguishedName ?? null,
        shape: 'rounded',
      }"
      :subtitle="group && group.description !== group.name ? group.description : null"
      :identifier="identifier"
      :dn="group?.distinguishedName ?? ''"
      :links="links"
      :tabs="tabs"
      fallback-tab="overview"
      :actions="actions"
      :actions-busy="adding"
      :refreshing="refreshing"
      :cached-at="group?.freshness.cachedAt ?? null"
      :live-refreshed-at="group?.freshness.liveRefreshedAt ?? null"
      @refresh="refreshFromAd"
    >
      <template v-if="group" #badges>
        <span v-if="group.groupType === 'security'" class="badge badge-blue badge-lg">
          <i class="pi pi-shield" /> security
        </span>
        <span v-else-if="group.groupType === 'distribution'" class="badge badge-violet badge-lg">
          <i class="pi pi-envelope" /> distribution
        </span>
        <span v-if="group.groupScope" class="badge badge-muted badge-lg mono">{{
          group.groupScope
        }}</span>
      </template>

      <template v-if="group" #default="{ tab: activeTab, select: selectTab }">
        <div v-if="activeTab === 'overview'" class="detail-grid">
          <Card title="Group">
            <dl class="kv-grid">
              <dt class="fld-label">Name</dt>
              <dd>{{ group.name ?? '—' }}</dd>
              <dt class="fld-label">Pre-Windows 2000 name</dt>
              <dd class="mono">{{ group.samAccountName ?? '—' }}</dd>
              <dt class="fld-label">Type</dt>
              <dd>{{ group.groupType ?? '—' }}</dd>
              <dt class="fld-label">Scope</dt>
              <dd>{{ group.groupScope ?? '—' }}</dd>
              <dt class="fld-label">Email</dt>
              <dd class="mono">{{ group.email ?? '—' }}</dd>
              <dt class="fld-label">Description</dt>
              <dd>{{ group.description ?? '—' }}</dd>
            </dl>
          </Card>

          <Card>
            <template #head>
              <h3 class="dc-card-title">
                Members
                <span class="ds-tab-count mono">{{ memberCount }}</span>
              </h3>
            </template>
            <template #actions>
              <Button
                label="View all"
                text
                size="small"
                severity="secondary"
                @click="selectTab('members')"
              />
            </template>
            <EmptyState
              v-if="memberCount === 0"
              icon="pi pi-users"
              title="No members in cache"
              compact
            />
            <ul v-else class="member-list">
              <li v-for="m in membersTop" :key="m.id">
                <router-link :to="memberRoute(m)" class="member-link">
                  <Avatar
                    :name="memberLabel(m)"
                    :seed="m.samAccountName ?? m.id"
                    :shape="avatarShape(m)"
                    :size="22"
                  />
                  <span>{{ memberLabel(m) }}</span>
                </router-link>
              </li>
              <li v-if="memberCount > membersTop.length" class="hint">
                + {{ memberCount - membersTop.length }} more
              </li>
            </ul>
          </Card>
        </div>

        <Card
          v-else-if="activeTab === 'members'"
          title="Members"
          sub="From cache · sync rebuilds memberships nightly"
          flush
        >
          <template v-if="canManage" #actions>
            <Button label="Add member" icon="pi pi-user-plus" size="small" @click="openAdd" />
          </template>
          <InlineFailure
            v-if="membersFailure"
            class="members-failure"
            :summary="membersFailure.summary"
            :message="membersFailure.message"
            :busy="pending !== null"
            @retry="retry"
            @dismiss="dismiss"
          />
          <EmptyState
            v-if="memberCount === 0"
            icon="pi pi-users"
            title="No members in cache"
            message="Run a sync if this seems wrong, or add a member to get started."
          >
            <template #actions>
              <Button v-if="canManage" label="Add member" icon="pi pi-user-plus" @click="openAdd" />
            </template>
          </EmptyState>
          <DataTable
            v-else
            :value="group.members"
            data-key="id"
            @row-click="openMember"
            class="members-table"
          >
            <Column header="Member" :style="{ minWidth: '260px' }">
              <template #body="{ data }">
                <div class="user-cell">
                  <Avatar
                    :name="memberLabel(data)"
                    :seed="data.samAccountName ?? data.id"
                    :shape="avatarShape(data)"
                    :size="26"
                  />
                  <div class="user-cell-stack">
                    <div class="user-name">
                      {{ memberLabel(data) }}
                      <span
                        v-if="data.kind === 'user' && data.passwordNeverExpires"
                        class="badge badge-violet name-flag"
                        title="never expires"
                      >
                        <i class="pi pi-shield" /> never expires
                      </span>
                    </div>
                    <div class="user-meta">{{ accountOf(data) }}</div>
                  </div>
                </div>
              </template>
            </Column>
            <Column header="Status" :style="{ width: '140px' }">
              <template #body="{ data }">
                <StatusBadge v-if="data.kind === 'user'" :user="data" />
                <span v-else class="badge badge-muted"><i class="pi pi-users" /> group</span>
              </template>
            </Column>
            <Column header="Email" :style="{ minWidth: '220px' }">
              <template #body="{ data }">
                <span class="cell-mono">{{ (data.kind === 'user' && data.email) || '—' }}</span>
              </template>
            </Column>
            <Column :style="{ width: '110px' }" header-style="text-align: right">
              <template #body="{ data }">
                <Button
                  v-if="canManage"
                  label="Remove"
                  :aria-label="`Remove ${memberLabel(data)}`"
                  icon="pi pi-times"
                  severity="danger"
                  size="small"
                  text
                  :loading="removingMemberId === (data as GroupMember).id"
                  :disabled="pending !== null"
                  @click.stop="startRemove(data as GroupMember)"
                />
              </template>
            </Column>
          </DataTable>
        </Card>
      </template>
    </ObjectPageLayout>

    <DeleteGroupDialog
      v-if="deleteOpen"
      v-model:visible="deleteOpen"
      :id="props.id"
      @deleted="onDeleted"
    />

    <!-- Add-member dialog -->
    <Dialog
      :visible="addOpen"
      modal
      header="Add member to group"
      :style="{ width: '32rem' }"
      :closable="!adding"
      @update:visible="(v) => !v && closeAdd()"
    >
      <div class="add-form">
        <p class="dialog-prose">Search the directory to pick a user or group to add.</p>
        <InputText
          v-model="addQuery"
          placeholder="name, username, UPN, email, group name"
          aria-label="Find a user or group"
          class="w-full"
        />
        <ul v-if="addResults.length > 0" class="result-list" role="listbox">
          <li
            v-for="c in addResults"
            :key="c.id"
            class="result-row"
            :class="{ active: addSelected?.id === c.id }"
            role="option"
            :aria-selected="addSelected?.id === c.id"
            @click="addSelected = c"
          >
            <Avatar
              :name="memberLabel(c)"
              :seed="c.samAccountName ?? c.id"
              :shape="avatarShape(c)"
              :size="24"
            />
            <div class="result-stack">
              <div class="result-name">{{ memberLabel(c) }}</div>
              <div class="result-meta mono">{{ accountOf(c) }}</div>
            </div>
            <StatusBadge v-if="c.kind === 'user'" :user="c" />
            <span v-else class="badge badge-muted"><i class="pi pi-users" /> group</span>
          </li>
        </ul>
        <Message v-else-if="addSearchError" severity="error" :closable="false">
          Couldn’t search the directory: {{ addSearchError }}
        </Message>
        <p v-else-if="addQuery.trim() && !addLoading" class="hint">
          No users or groups matched that aren’t members already.
        </p>
        <p v-if="addLoading" class="hint">Searching…</p>
        <Message v-if="addFailure" severity="error" closable @close="dismiss">
          Couldn’t {{ membershipChangeText(addFailure.op.change, addFailure.op.membership) }}:
          {{ addFailure.message }}
        </Message>
      </div>
      <template #footer>
        <Button label="Cancel" text severity="secondary" :disabled="adding" @click="closeAdd" />
        <Button
          label="Add"
          :disabled="!addSelected || adding"
          :loading="adding"
          @click="confirmAdd"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.members-failure {
  margin: 12px 16px;
}

.group-detail-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}

@media (max-width: 1100px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}

.kv-grid {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 6px 14px;
  margin: 0;
  font-size: 13px;
  color: var(--text);
  align-items: center;
}

.kv-grid dt {
  color: var(--text-3);
}

.kv-grid dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.member-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  text-decoration: none;
}

.member-link:hover {
  color: var(--accent);
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
}

.name-flag {
  font-size: 10px;
  font-weight: 500;
  height: 18px;
  padding: 0 6px;
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

/* Add-member dialog ------------------------------------------------------- */
.add-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dialog-prose {
  font-size: 13px;
  color: var(--text-2);
  margin: 0;
}

.result-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  max-height: 280px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
}

.result-row:hover {
  background: var(--hover);
}

.result-row.active {
  background: var(--accent-soft);
}

.result-stack {
  flex: 1;
  min-width: 0;
}

.result-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-meta {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.w-full {
  width: 100%;
}
</style>
