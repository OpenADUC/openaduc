<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import DataTable, { type DataTableRowClickEvent } from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import type { GroupDetail, GroupMember, UserSummary } from '@openaduc/shared';
import LiveBadge from '../design/primitives/LiveBadge.vue';
import Card from '../design/primitives/Card.vue';
import StatusBadge from '../design/primitives/StatusBadge.vue';
import Avatar from '../design/primitives/Avatar.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import { fmtRelative } from '../design/lib/format.js';
import { useStickyHeader } from './_detail/useStickyHeader';

const props = defineProps<{ id: string }>();
const router = useRouter();
const auth = useAuthStore();
const toast = useToast();

const group = ref<GroupDetail | null>(null);
const loading = ref(false);
const refreshing = ref(false);
const error = ref<string | null>(null);

// Drives the compact-on-scroll hero. `setHero` is bound to the hero
// section's :ref. `compact` flips on scroll; `heroHeight` tracks the
// rendered height so the Members card's sticky head pins flush with
// the hero's current bottom edge.
const { setHero, compact, heroHeight } = useStickyHeader();

// Member-add dialog state — opens on "Add member", searches the user
// directory, and applies the selected user via the group-membership endpoint.
const addOpen = ref(false);
const addQuery = ref('');
const addResults = ref<UserSummary[]>([]);
const addLoading = ref(false);
const addSelected = ref<UserSummary | null>(null);
let addTimer: ReturnType<typeof setTimeout> | undefined;

// Action state — single bool now that step-up/password-prompt is consolidated
// into the EditModeFab. Each membership change calls the API directly with
// the cached step-up creds; we track which row is busy for the per-row spinner.
const writeRunning = ref(false);
const busyMemberId = ref<string | null>(null);

const canManage = computed(() => auth.hasCapability('write:group.membership'));
const memberCount = computed(() => group.value?.members.length ?? 0);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await api.groups.get(props.id);
    group.value = r.group;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      error.value = 'Group not found';
    } else {
      error.value = err instanceof Error ? err.message : 'Failed to load group';
    }
  } finally {
    loading.value = false;
  }
}

async function refreshFromAd(): Promise<void> {
  // Same trick as user detail: GET always live-refreshes.
  refreshing.value = true;
  try {
    await load();
    toast.add({ severity: 'success', summary: 'Refreshed', life: 2000 });
  } finally {
    refreshing.value = false;
  }
}

watch(() => props.id, load);
onMounted(load);

// ---- Add member -----------------------------------------------------------

function openAdd(): void {
  addOpen.value = true;
  addQuery.value = '';
  addResults.value = [];
  addSelected.value = null;
}

function onAddSearchInput(): void {
  if (addTimer) clearTimeout(addTimer);
  if (!addQuery.value.trim()) {
    addResults.value = [];
    return;
  }
  addTimer = setTimeout(async () => {
    addLoading.value = true;
    try {
      const r = await api.users.search({ q: addQuery.value.trim(), pageSize: 20 });
      // Filter out users who are already members so the operator can't
      // accidentally try to add a duplicate.
      const memberIds = new Set((group.value?.members ?? []).map((m) => m.id));
      addResults.value = r.rows.filter((u) => !memberIds.has(u.id));
    } catch {
      addResults.value = [];
    } finally {
      addLoading.value = false;
    }
  }, 250);
}

function selectAddCandidate(u: UserSummary): void {
  addSelected.value = u;
}

async function confirmAdd(): Promise<void> {
  if (!addSelected.value || !group.value) return;
  const target = addSelected.value;
  const userName = target.displayName ?? target.samAccountName;
  writeRunning.value = true;
  try {
    await api.users.addGroup(target.id, { groupId: group.value.id });
    toast.add({
      severity: 'success',
      summary: 'Added to group',
      detail: `${userName} → ${group.value.name}`,
      life: 3000,
    });
    addOpen.value = false;
    addSelected.value = null;
    addQuery.value = '';
    addResults.value = [];
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = confirmAdd;
      return;
    }
    toast.add({
      severity: 'error',
      summary: 'Add failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    writeRunning.value = false;
  }
}

async function startRemove(member: GroupMember): Promise<void> {
  if (!group.value) return;
  const userName = member.displayName ?? member.samAccountName;
  busyMemberId.value = member.id;
  try {
    await api.users.removeGroup(member.id, { groupId: group.value.id });
    toast.add({
      severity: 'success',
      summary: 'Removed from group',
      detail: `${userName} ← ${group.value.name}`,
      life: 3000,
    });
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = () => startRemove(member);
      return;
    }
    toast.add({
      severity: 'error',
      summary: 'Remove failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    busyMemberId.value = null;
  }
}

function openMember(ev: DataTableRowClickEvent): void {
  const row = ev.data as GroupMember;
  void router.push({ name: 'user-detail', params: { id: row.id } });
}

function memberInitials(m: GroupMember): string {
  return ((m.displayName ?? m.samAccountName) || '?').slice(0, 1).toUpperCase();
}
void memberInitials;

// Render the DN with the leading CN= segment stripped so the chip doesn't
// repeat the heading. Falls back to the full DN when the CN doesn't match
// the visible group name. Mirrors the User detail page's `dnPath`.
const dnPath = computed(() => {
  const dn = group.value?.distinguishedName ?? '';
  if (!dn) return '';
  const m = /^CN=([^,]+),(.*)$/i.exec(dn);
  if (!m) return dn;
  const cn = m[1]!.replace(/\\,/g, ',');
  const rest = m[2]!;
  const heading = (group.value?.name ?? group.value?.samAccountName ?? '').trim();
  return cn === heading ? rest : dn;
});

const mailtoHref = computed(() => (group.value?.email ? `mailto:${group.value.email}` : null));

const copied = ref<{ email: boolean; dn: boolean }>({ email: false, dn: false });
async function copy(kind: 'email' | 'dn'): Promise<void> {
  const g = group.value;
  if (!g) return;
  const text = kind === 'email' ? (g.email ?? '') : g.distinguishedName;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = { ...copied.value, [kind]: true };
    setTimeout(() => {
      copied.value = { ...copied.value, [kind]: false };
    }, 1800);
  } catch {
    toast.add({ severity: 'warn', summary: 'Clipboard unavailable', life: 2500 });
  }
}
</script>

<template>
  <Toast />
  <div
    class="page-inner group-detail-page"
    :style="{ '--detail-sticky-offset': `${heroHeight}px` }"
  >
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="group" class="detail-stack">
      <!-- Hero. Mirrors the User detail layout: avatar (rounded square so
           a group reads as a different class of thing than a person at a
           glance) + name/badges + email copy line + DN copy chip + email
           launcher. The aside on the right keeps LiveBadge + refresh
           since this view has no tab bar to host them. -->
      <section :ref="setHero" class="detail-hero" :class="{ 'is-compact': compact }">
        <Avatar
          :name="group.name ?? group.samAccountName"
          :seed="group.samAccountName ?? group.distinguishedName"
          :size="compact ? 28 : 64"
          shape="rounded"
        />

        <div class="detail-hero-main">
          <div class="detail-hero-row">
            <h1 class="detail-hero-name">{{ group.name ?? group.distinguishedName }}</h1>
            <span v-if="group.groupType === 'security'" class="badge badge-blue">
              <i class="pi pi-shield" /> security
            </span>
            <span v-else-if="group.groupType === 'distribution'" class="badge badge-violet">
              <i class="pi pi-envelope" /> distribution
            </span>
            <span v-if="group.groupScope" class="badge badge-muted mono">{{
              group.groupScope
            }}</span>
          </div>

          <div
            v-if="group.description && group.description !== group.name"
            class="detail-hero-title"
          >
            {{ group.description }}
          </div>

          <!-- Primary identifier line. Prefers the email; falls back to
               the sAMAccountName so there's always one copy-able line. -->
          <button
            v-if="group.email"
            type="button"
            class="copybtn copybtn-inline"
            :title="copied.email ? 'Copied!' : 'Copy email'"
            @click="copy('email')"
          >
            <i :class="copied.email ? 'pi pi-check' : 'pi pi-copy'" />
            <span class="mono">{{ group.email }}</span>
          </button>
          <div v-else-if="group.samAccountName" class="detail-hero-upn mono">
            {{ group.samAccountName }}
          </div>

          <div class="detail-hero-actions-row">
            <a v-if="mailtoHref" class="copybtn launcher" :href="mailtoHref" title="Send email">
              <i class="pi pi-envelope" />
              <span>Email</span>
            </a>
            <button
              type="button"
              class="copybtn launcher hero-path"
              :title="copied.dn ? 'Copied!' : 'Copy distinguished name'"
              @click="copy('dn')"
            >
              <i :class="copied.dn ? 'pi pi-check' : 'pi pi-sitemap'" />
              <span class="mono hero-path-text">{{ dnPath }}</span>
            </button>
          </div>
        </div>

        <aside class="detail-hero-aside">
          <div class="freshness-row">
            <LiveBadge
              :live-at="group.freshness.liveRefreshedAt"
              :cached-at="group.freshness.cachedAt"
              variant="pill"
            />
            <Button
              icon="pi pi-refresh"
              text
              severity="secondary"
              size="small"
              :loading="refreshing"
              title="Refresh from directory"
              @click="refreshFromAd"
            />
          </div>
        </aside>
      </section>

      <!-- Members title bar. Sibling of the hero rather than the Card's
           own header so it pins cleanly via the same pattern as the User
           page's tab bar — sticky-inside-Card was getting clipped by the
           card's layout. -->
      <nav class="members-bar" aria-label="Members section">
        <div class="members-bar-title">
          <h3>Members ({{ memberCount }})</h3>
          <span class="members-bar-sub">from cache · sync rebuilds memberships nightly</span>
        </div>
        <div class="members-bar-spacer" />
        <Button
          v-if="canManage"
          label="Add member"
          icon="pi pi-user-plus"
          size="small"
          @click="auth.requireEdit(openAdd)"
        />
      </nav>

      <Card flush>
        <EmptyState
          v-if="memberCount === 0"
          icon="pi pi-users"
          title="No members in cache"
          message="Run a sync if this seems wrong, or add a member to get started."
        >
          <template #actions>
            <Button
              v-if="canManage"
              label="Add member"
              icon="pi pi-user-plus"
              @click="auth.requireEdit(openAdd)"
            />
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
                  :name="data.displayName ?? data.samAccountName"
                  :seed="data.samAccountName"
                  :size="26"
                />
                <div class="user-cell-stack">
                  <div class="user-name">
                    {{ data.displayName ?? data.samAccountName }}
                    <span
                      v-if="data.passwordNeverExpires"
                      class="badge badge-violet name-flag"
                      title="never expires"
                    >
                      <i class="pi pi-shield" /> never expires
                    </span>
                  </div>
                  <div class="user-meta">{{ data.userPrincipalName ?? data.samAccountName }}</div>
                </div>
              </div>
            </template>
          </Column>
          <Column header="Status" :style="{ width: '140px' }">
            <template #body="{ data }">
              <StatusBadge :user="data" />
            </template>
          </Column>
          <Column header="Email" :style="{ minWidth: '220px' }">
            <template #body="{ data }">
              <span class="cell-mono">{{ data.email ?? '—' }}</span>
            </template>
          </Column>
          <Column :style="{ width: '110px' }" header-style="text-align: right">
            <template #body="{ data }">
              <Button
                v-if="canManage"
                label="Remove"
                icon="pi pi-times"
                severity="danger"
                size="small"
                text
                :loading="busyMemberId === (data as GroupMember).id"
                @click.stop="auth.requireEdit(() => startRemove(data as GroupMember))"
              />
            </template>
          </Column>
        </DataTable>
      </Card>
    </div>

    <!-- Add-member dialog -->
    <Dialog
      :visible="addOpen"
      modal
      header="Add member to group"
      :style="{ width: '32rem' }"
      :closable="!writeRunning"
      @update:visible="(v) => !v && (addOpen = false)"
    >
      <div class="add-form">
        <p class="dialog-prose">Search the directory to pick a user to add.</p>
        <InputText
          v-model="addQuery"
          placeholder="name, username, UPN, email"
          class="w-full"
          @input="onAddSearchInput"
        />
        <ul v-if="addResults.length > 0" class="result-list" role="listbox">
          <li
            v-for="u in addResults"
            :key="u.id"
            class="result-row"
            :class="{ active: addSelected?.id === u.id }"
            role="option"
            :aria-selected="addSelected?.id === u.id"
            @click="selectAddCandidate(u)"
          >
            <Avatar :name="u.displayName ?? u.samAccountName" :seed="u.samAccountName" :size="24" />
            <div class="result-stack">
              <div class="result-name">{{ u.displayName ?? u.samAccountName }}</div>
              <div class="result-meta mono">{{ u.userPrincipalName ?? u.samAccountName }}</div>
            </div>
            <StatusBadge :user="u" />
          </li>
        </ul>
        <p v-else-if="addQuery.trim() && !addLoading" class="hint">No users matched.</p>
        <p v-if="addLoading" class="hint">Searching…</p>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          :disabled="writeRunning"
          @click="addOpen = false"
        />
        <Button
          label="Add"
          :disabled="!addSelected || writeRunning"
          :loading="writeRunning"
          @click="confirmAdd"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.group-detail-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* --detail-sticky-offset is set inline (reactive to hero height) so
     the Members card's sticky head pins flush with the hero's current
     bottom edge, even mid-shrink-animation. */
  /* Disable browser scroll anchoring inside the detail page — see the
     User detail page for rationale. */
  overflow-anchor: none;
}

.detail-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Hero — mirrors UserDetailView: 3-column grid (avatar | main | aside)
   so the layout is consistent across people / groups / computers. */
.detail-hero {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--accent) 5%, var(--surface)),
    var(--surface)
  );
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 16px;
  min-width: 0;
  position: sticky;
  top: 0;
  z-index: 6;
  transition:
    padding 200ms ease,
    gap 200ms ease,
    border-radius 200ms ease,
    box-shadow 200ms ease;
}

/* Compact: padding tightens, avatar shrinks via reactive :size prop,
   secondary rows collapse, aside collapses to zero. Corners square off
   so the pinned hero merges with the Members bar below. */
.detail-hero.is-compact {
  padding: 6px 14px;
  align-items: center;
  gap: 10px;
  border-radius: 0;
  border-bottom: 0;
  box-shadow: none;
}

.detail-hero-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-hero-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-hero-name {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--text);
  transition: font-size 200ms ease;
}

.detail-hero.is-compact .detail-hero-name {
  font-size: 14px;
}

/* Secondary rows fold to zero in compact. */
.detail-hero-title,
.detail-hero-upn,
.detail-hero-actions-row,
.copybtn-inline {
  overflow: hidden;
  max-height: 60px;
  opacity: 1;
  transition:
    max-height 200ms ease,
    opacity 150ms ease,
    margin 200ms ease;
}

.detail-hero.is-compact .detail-hero-title,
.detail-hero.is-compact .detail-hero-upn,
.detail-hero.is-compact .detail-hero-actions-row,
.detail-hero.is-compact .copybtn-inline {
  max-height: 0;
  opacity: 0;
  margin: 0;
  pointer-events: none;
}

.detail-hero-title {
  color: var(--text-2);
  font-size: 13px;
  margin-top: 4px;
}

.detail-hero-upn {
  color: var(--text-3);
  font-size: 12.5px;
  margin-top: 2px;
}

.detail-hero-actions-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

/* Copy / launcher chips — mirror UserDetailView. */
.copybtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-sans);
  text-decoration: none;
  max-width: 100%;
  overflow: hidden;
}

.copybtn:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--surface-3);
}

.copybtn .mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hero-path {
  flex: 1 1 auto;
  min-width: 120px;
  max-width: 100%;
  justify-content: flex-start;
}

.hero-path .hero-path-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  flex: 1 1 auto;
}

.copybtn-inline {
  height: auto;
  padding: 2px 0;
  margin-top: 2px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 12.5px;
}

.copybtn-inline:hover {
  background: transparent;
  color: var(--text);
  border-color: transparent;
}

.copybtn-inline .mono {
  font-size: 12.5px;
}

.detail-hero-aside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  overflow: hidden;
  max-width: 280px;
  opacity: 1;
  transition:
    max-width 200ms ease,
    opacity 150ms ease;
}

.detail-hero.is-compact .detail-hero-aside {
  max-width: 0;
  opacity: 0;
  pointer-events: none;
}

@media (max-width: 767.98px) {
  .detail-hero {
    grid-template-columns: auto 1fr;
  }
  .detail-hero-aside {
    grid-column: 1 / -1;
    align-items: flex-start;
  }
}

/* Members title bar. Side + bottom border (no top, no rounded
   corners) so the bar reads as a continuation of the cards above
   and below: at full hero, the hero's and data card's left/right
   borders line up with the bar's; once the compact hero pins above,
   the no-top-border bar merges into it as one banner. The
   pronounced drop shadow makes it clear that the member list
   scrolls beneath the pinned unit. */
.members-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: var(--detail-sticky-offset, 40px);
  z-index: 5;
  box-shadow: 0 10px 18px -10px rgba(0, 0, 0, 0.28);
}

.members-bar-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.members-bar-title h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.members-bar-sub {
  font-size: 11.5px;
  color: var(--text-3);
}

.members-bar-spacer {
  flex: 1 1 auto;
}

.freshness-row {
  display: flex;
  align-items: center;
  gap: 6px;
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

:deep(.members-table) {
  border: 1px solid var(--border);
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
