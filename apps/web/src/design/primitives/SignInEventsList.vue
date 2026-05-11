<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import type { SignInEvent } from '@openaduc/shared';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';
import EmptyState from './EmptyState.vue';

// Paged list of cached Microsoft Entra sign-in events. Backed by the
// local entra_signin_events table; filters are sent server-side. Used in:
//   - User detail page (Sign-ins tab): pass `userId` to lock the filter
//   - Global audit page (Sign-ins tab): pass filters from a parent
//     filter bar (search, app, status, date range)
//
// Click on a row → emits `select` with the event id; parent renders a
// SignInEventDetailDialog to show everything (including detail_json).

// All optionals carry an explicit `| undefined` so callers can pass
// computed values that may resolve to undefined under
// exactOptionalPropertyTypes (Vite/vue-tsc strict mode).
const props = defineProps<{
  directoryId: number;
  /** Lock to one user (AD objectGuid). Hides the user column in rows. */
  userId?: string | undefined;
  appId?: string | undefined;
  status?: 'success' | 'failure' | 'all' | undefined;
  fromIso?: string | undefined;
  toIso?: string | undefined;
  search?: string | undefined;
  /** Page size — default 50, max 200. */
  pageSize?: number | undefined;
  /** Hide the userPrincipalName column (redundant on the user detail tab). */
  hideUserColumn?: boolean | undefined;
  /** External refresh trigger from parent (e.g. when filters change). */
  refreshKey?: number | string | undefined;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
}>();

const events = ref<SignInEvent[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = computed(() => props.pageSize ?? 50);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const errorHint = ref<string | null>(null);

const hasMore = computed(() => events.value.length < total.value);

async function load(reset = true): Promise<void> {
  if (reset) {
    loading.value = true;
    page.value = 1;
    events.value = [];
    total.value = 0;
  } else {
    loadingMore.value = true;
  }
  error.value = null;
  errorHint.value = null;
  try {
    const r = await api.directories.entra.signInEvents(props.directoryId, {
      ...(props.userId ? { userId: props.userId } : {}),
      ...(props.appId ? { appId: props.appId } : {}),
      ...(props.status ? { status: props.status } : {}),
      ...(props.fromIso ? { fromIso: props.fromIso } : {}),
      ...(props.toIso ? { toIso: props.toIso } : {}),
      ...(props.search ? { search: props.search } : {}),
      page: page.value,
      pageSize: pageSize.value,
    });
    if (reset) {
      events.value = r.events;
    } else {
      events.value.push(...r.events);
    }
    total.value = r.total;
  } catch (err) {
    if (err instanceof ApiError) {
      error.value = err.message;
      const body = (err as unknown as { body?: { hint?: string } }).body;
      if (body?.hint) errorHint.value = body.hint;
    } else {
      error.value = err instanceof Error ? err.message : 'Failed to load sign-ins';
    }
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loadingMore.value) return;
  page.value += 1;
  await load(false);
}

// Refetch on any filter change. Parent uses refreshKey to force a
// reload after changes that don't affect the props (manual refresh).
watch(
  () => [
    props.directoryId,
    props.userId,
    props.appId,
    props.status,
    props.fromIso,
    props.toIso,
    props.search,
    props.refreshKey,
  ],
  () => {
    void load(true);
  },
);

onMounted(() => void load(true));

defineExpose({ refresh: () => load(true) });

// Status label + tone. errorCode === 0 = success unless CA failed.
function statusLabel(ev: SignInEvent): string {
  if (ev.status?.errorCode === 0) {
    if (ev.conditionalAccessStatus === 'failure') return 'CA blocked';
    return 'success';
  }
  if (ev.status?.failureReason) return ev.status.failureReason;
  return `error ${ev.status?.errorCode ?? '?'}`;
}

function statusTone(ev: SignInEvent): 'green' | 'red' | 'amber' {
  if (ev.status?.errorCode === 0) {
    if (ev.conditionalAccessStatus === 'failure') return 'red';
    return 'green';
  }
  return 'red';
}

function locationLabel(ev: SignInEvent): string {
  if (!ev.location) return '';
  return [ev.location.city, ev.location.state, ev.location.countryOrRegion]
    .filter(Boolean)
    .join(', ');
}

function deviceLabel(ev: SignInEvent): string {
  if (!ev.device) return '';
  return [ev.device.os, ev.device.browser].filter(Boolean).join(' · ');
}

function methodsLabel(ev: SignInEvent): string {
  if (ev.authenticationMethods.length === 0) return '—';
  return ev.authenticationMethods.join(' + ');
}

function ipKindLabel(ip: string | null): string {
  if (!ip) return '';
  return ip.includes(':') ? 'IPv6' : 'IPv4';
}

function riskTone(ev: SignInEvent): 'red' | 'amber' | 'muted' {
  if (ev.riskLevel === 'high' || ev.riskState === 'atRisk') return 'red';
  if (ev.riskLevel === 'medium') return 'amber';
  return 'muted';
}

function onRowClick(ev: SignInEvent): void {
  emit('select', ev.id);
}
</script>

<template>
  <div class="signin-list">
    <Message v-if="error" severity="error" :closable="false">
      <div>{{ error }}</div>
      <div v-if="errorHint" class="signin-hint">{{ errorHint }}</div>
    </Message>

    <div v-else-if="loading && events.length === 0" class="signin-loading">Loading sign-ins…</div>

    <EmptyState
      v-else-if="!loading && events.length === 0"
      icon="pi pi-sign-in"
      title="No sign-in events"
      :message="
        userId
          ? 'This user has no recent sign-ins recorded by Entra.'
          : 'No sign-in events match the current filters.'
      "
    />

    <ul v-else class="signin-rows">
      <li
        v-for="ev in events"
        :key="ev.id"
        class="signin-row"
        tabindex="0"
        role="button"
        :aria-label="`Sign-in details for ${ev.userDisplayName ?? ev.userPrincipalName ?? 'event'}`"
        @click="onRowClick(ev)"
        @keydown.enter.prevent="onRowClick(ev)"
        @keydown.space.prevent="onRowClick(ev)"
      >
        <div class="signin-row-time">
          <div class="mono signin-abs">{{ fmtAbsolute(ev.createdDateTime) }}</div>
          <div class="signin-rel">{{ fmtRelative(ev.createdDateTime) }}</div>
        </div>

        <div class="signin-row-main">
          <div class="signin-line-1">
            <span class="badge" :class="`badge-${statusTone(ev)}`">{{ statusLabel(ev) }}</span>
            <span v-if="!hideUserColumn && ev.userDisplayName" class="signin-user">{{
              ev.userDisplayName
            }}</span>
            <span v-if="!hideUserColumn && ev.userPrincipalName" class="signin-upn mono">{{
              ev.userPrincipalName
            }}</span>
            <span v-if="ev.appDisplayName" class="signin-app">→ {{ ev.appDisplayName }}</span>
          </div>
          <div class="signin-line-2">
            <span
              v-if="ev.ipAddress"
              class="signin-meta mono"
              :title="`Source IP recorded by Entra (${ipKindLabel(ev.ipAddress)}). Only one address per event — whichever the client connected with.`"
              >{{ ev.ipAddress }}</span
            >
            <span v-if="locationLabel(ev)" class="signin-meta">{{ locationLabel(ev) }}</span>
            <span v-if="deviceLabel(ev)" class="signin-meta">{{ deviceLabel(ev) }}</span>
            <span v-if="ev.clientAppUsed" class="signin-meta">{{ ev.clientAppUsed }}</span>
            <span
              class="signin-meta"
              :class="{ 'signin-mfa-strong': ev.authenticationMethods.length > 1 }"
              title="Authentication methods that succeeded for this sign-in"
            >
              <i class="pi pi-lock" /> {{ methodsLabel(ev) }}
            </span>
            <span
              v-if="ev.riskLevel && ev.riskLevel !== 'none' && ev.riskLevel !== 'hidden'"
              class="signin-meta"
              :class="`risk-${riskTone(ev)}`"
              title="Entra risk assessment"
              >risk: {{ ev.riskLevel }}</span
            >
            <span
              v-if="ev.conditionalAccessStatus && ev.conditionalAccessStatus !== 'notApplied'"
              class="signin-meta"
              title="Conditional Access policy result"
            >
              CA: {{ ev.conditionalAccessStatus }}
            </span>
          </div>
        </div>
      </li>
    </ul>

    <div v-if="!loading && !error" class="signin-footer">
      <span class="signin-count"
        >{{ events.length.toLocaleString() }} of {{ total.toLocaleString() }} events</span
      >
      <Button
        v-if="hasMore"
        label="Load more"
        size="small"
        severity="secondary"
        outlined
        :loading="loadingMore"
        @click="loadMore"
      />
    </div>
  </div>
</template>

<style scoped>
.signin-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.signin-loading {
  font-size: 13px;
  color: var(--text-3);
  padding: 12px 4px;
}

.signin-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}

.signin-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.signin-row {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  cursor: pointer;
  outline: none;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.signin-row:hover,
.signin-row:focus-visible {
  border-color: var(--accent);
  background: var(--surface-2, var(--surface));
}

.signin-row-time {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.signin-abs {
  font-size: 12px;
  color: var(--text-2);
}

.signin-rel {
  font-size: 11px;
  color: var(--text-3);
}

.signin-row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.signin-line-1 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.signin-line-2 {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-3);
}

.signin-user {
  font-weight: 600;
  color: var(--text);
}

.signin-upn {
  color: var(--text-2);
  font-size: 12px;
}

.signin-app {
  color: var(--text-2);
}

.signin-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.signin-mfa-strong {
  color: var(--success-text, var(--accent-text));
}

.risk-red {
  color: var(--danger-text, #b00020);
  font-weight: 600;
}

.risk-amber {
  color: #b56b00;
  font-weight: 600;
}

.signin-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 4px;
}

.signin-count {
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
