<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import type { ComputerDetail } from '@openaduc/shared';
import LiveBadge from '../design/primitives/LiveBadge.vue';
import Card from '../design/primitives/Card.vue';
import Avatar from '../design/primitives/Avatar.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import { fmtRelative } from '../design/lib/format.js';
import { useStickyHeader } from './_detail/useStickyHeader';

const props = defineProps<{ id: string }>();
const router = useRouter();
const toast = useToast();

const computer = ref<ComputerDetail | null>(null);
const loading = ref(false);
const refreshing = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await api.computers.get(props.id);
    computer.value = r.computer;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      error.value = 'Computer not found';
    } else {
      error.value = err instanceof Error ? err.message : 'Failed to load computer';
    }
  } finally {
    loading.value = false;
  }
}

async function refreshFromAd(): Promise<void> {
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

// Drives the compact-on-scroll hero. `setHero` is bound to the hero
// section's :ref. `compact` flips on scroll; `heroHeight` is unused
// here because Computer has no sticky child below the hero.
const { setHero, compact } = useStickyHeader();

const groupCount = computed(() => computer.value?.groupMemberships.length ?? 0);

function openGroup(g: ComputerDetail['groupMemberships'][number]): void {
  if (!g.id) return;
  void router.push({ name: 'group-detail', params: { id: g.id } });
}

function openManagedBy(): void {
  if (!computer.value?.managedBy?.id) return;
  void router.push({
    name: 'user-detail',
    params: { id: computer.value.managedBy.id },
  });
}
</script>

<template>
  <Toast />
  <div class="page-inner computer-detail-page">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="computer" class="detail-stack">
      <section :ref="setHero" class="detail-hero" :class="{ 'is-compact': compact }">
        <div class="detail-hero-top">
          <div class="detail-hero-main">
            <Avatar
              :name="computer.name ?? computer.distinguishedName"
              :seed="computer.samAccountName ?? computer.distinguishedName"
              :size="compact ? 26 : 64"
              shape="rounded"
              icon="pi-desktop"
            />
            <div class="detail-hero-meta">
              <div class="detail-hero-row">
                <h1 class="detail-hero-name">
                  {{ computer.name ?? computer.distinguishedName }}
                </h1>
                <span v-if="computer.enabled" class="badge badge-green" title="enabled">
                  <i class="pi pi-check-circle" /> enabled
                </span>
                <span v-else class="badge badge-red" title="disabled">
                  <i class="pi pi-ban" /> disabled
                </span>
                <span
                  v-if="computer.freshness.isStale"
                  class="badge badge-amber"
                  title="cache row marked stale"
                >
                  <i class="pi pi-clock" /> stale
                </span>
              </div>
              <div v-if="computer.dnsHostName" class="detail-hero-fqdn mono">
                {{ computer.dnsHostName }}
              </div>
              <div v-if="computer.description" class="detail-hero-title">
                {{ computer.description }}
              </div>
              <div class="detail-hero-dn mono">{{ computer.distinguishedName }}</div>
            </div>
          </div>
          <aside class="detail-hero-aside">
            <div class="freshness-row">
              <LiveBadge :cached-at="computer.freshness.cachedAt" variant="pill" />
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
        </div>
      </section>

      <Card title="Identity" sub="Read from Active Directory">
        <dl class="kv-grid">
          <dt>Name</dt>
          <dd>{{ computer.name ?? '—' }}</dd>
          <dt>sAMAccountName</dt>
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
    </div>
  </div>
</template>

<style scoped>
.computer-detail-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* Disable browser scroll anchoring inside the detail page — see the
     User detail page for rationale (compact-on-scroll flicker fix). */
  overflow-anchor: none;
}

.detail-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-hero {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--accent) 5%, var(--surface)),
    var(--surface)
  );
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: sticky;
  top: 0;
  z-index: 6;
  transition:
    padding 200ms ease,
    gap 200ms ease,
    border-radius 200ms ease,
    box-shadow 200ms ease;
}

/* Compact state: hero shrinks via padding/gap, secondary rows
   collapse to zero height, mark + name shrink. The same element
   handles both states so there's no mount/unmount mid-scroll. Top
   corners square off so the pinned hero reads as a banner extending
   from the topbar; bottom corners stay rounded since nothing merges
   below. The drop shadow signals that content scrolls underneath. */
.detail-hero.is-compact {
  padding: 6px 14px;
  gap: 0;
  border-radius: 0 0 8px 8px;
  box-shadow: 0 10px 18px -10px rgba(0, 0, 0, 0.24);
}

.detail-hero-top {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  width: 100%;
  transition: gap 200ms ease;
}

.detail-hero.is-compact .detail-hero-top {
  align-items: center;
  gap: 10px;
}

.detail-hero-main {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  flex: 1 1 auto;
  min-width: 0;
  transition: gap 200ms ease;
}

.detail-hero.is-compact .detail-hero-main {
  align-items: center;
  gap: 10px;
}

/* Avatar primitive renders the computer mark; sizing transitions live
   inside Avatar itself (driven by the reactive :size prop). */

.detail-hero-meta {
  flex: 1 1 auto;
  min-width: 0;
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

/* Secondary rows fold down to zero with smooth height + opacity so
   the hero's overall height transitions cleanly. Pointer-events off
   so nothing inside is clickable while collapsed. */
.detail-hero-fqdn,
.detail-hero-title,
.detail-hero-dn {
  overflow: hidden;
  max-height: 60px;
  opacity: 1;
  transition:
    max-height 200ms ease,
    opacity 150ms ease,
    margin 200ms ease;
}

.detail-hero.is-compact .detail-hero-fqdn,
.detail-hero.is-compact .detail-hero-title,
.detail-hero.is-compact .detail-hero-dn {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  pointer-events: none;
}

.detail-hero-fqdn {
  color: var(--text-2);
  font-size: 12px;
  margin-top: 4px;
}

.detail-hero-title {
  color: var(--text-2);
  font-size: 13px;
  margin-top: 4px;
}

.detail-hero-dn {
  color: var(--text-4);
  font-family: var(--font-mono);
  font-size: 11.5px;
  margin-top: 6px;
  word-break: break-all;
}

/* Aside (LiveBadge + refresh) collapses to zero in compact so the
   slim hero is just mark + name + status badge. */
.detail-hero-aside {
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

.detail-hero-aside {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.freshness-row {
  display: flex;
  align-items: center;
  gap: 6px;
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
