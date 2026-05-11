<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import type { SignInEventDetail } from '@openaduc/shared';
import { fmtAbsolute } from '../lib/format.js';

// Modal showing the full Microsoft Entra sign-in event payload — both
// the columns we promoted (status, app, IP, device, location, methods)
// AND the catch-all `detail` object holding everything else
// (additionalDetails, conditionalAccessPolicies, raw
// authenticationDetails with timestamps, networkLocationDetails, etc.).
//
// The "raw" section pretty-prints the JSON of `detail` so an operator
// debugging an unusual sign-in can see exactly what Graph returned
// without leaving the app. Useful for "why was this CA policy
// triggered" questions where the structured policies array is in
// detail_json.

const props = defineProps<{
  visible: boolean;
  directoryId: number;
  /** Local DB id from the list endpoint. Null = nothing selected. */
  eventId: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
}>();

const event = ref<SignInEventDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const visible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v),
});

watch(
  () => [props.visible, props.eventId],
  async ([nextVisible, nextId]) => {
    if (!nextVisible || !nextId) {
      event.value = null;
      error.value = null;
      return;
    }
    loading.value = true;
    error.value = null;
    event.value = null;
    try {
      const r = await api.directories.entra.signInEventDetail(props.directoryId, nextId as string);
      event.value = r.event;
    } catch (err) {
      error.value =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to load event detail';
    } finally {
      loading.value = false;
    }
  },
);

function statusLabel(ev: SignInEventDetail): string {
  if (ev.status?.errorCode === 0) {
    if (ev.conditionalAccessStatus === 'failure') return 'CA blocked';
    return 'success';
  }
  return ev.status?.failureReason ?? `error ${ev.status?.errorCode ?? '?'}`;
}

function statusTone(ev: SignInEventDetail): 'green' | 'red' {
  if (ev.status?.errorCode === 0 && ev.conditionalAccessStatus !== 'failure') return 'green';
  return 'red';
}

function ipKindLabel(ip: string | null): string {
  if (!ip) return '';
  return ip.includes(':') ? 'IPv6' : 'IPv4';
}

function locationLabel(ev: SignInEventDetail): string {
  if (!ev.location) return '—';
  const parts = [ev.location.city, ev.location.state, ev.location.countryOrRegion].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

const prettyDetail = computed(() => {
  if (!event.value) return '';
  return JSON.stringify(event.value.detail, null, 2);
});
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :style="{ width: '760px', maxWidth: '95vw' }"
    :header="event ? 'Sign-in event' : 'Loading…'"
    :pt="{ content: { style: 'padding-top: 0' } }"
  >
    <div v-if="loading" class="ev-loading">Loading event detail…</div>
    <Message v-else-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-else-if="event" class="ev-body">
      <!-- Hero: status badge + headline -->
      <header class="ev-hero">
        <span class="badge" :class="`badge-${statusTone(event)}`">{{ statusLabel(event) }}</span>
        <div class="ev-hero-title">
          <div class="ev-hero-name">{{ event.userDisplayName ?? '—' }}</div>
          <div class="ev-hero-upn mono">{{ event.userPrincipalName ?? '' }}</div>
        </div>
      </header>

      <section class="ev-section">
        <h4 class="ev-h">When + where</h4>
        <dl class="ev-grid">
          <dt>Time</dt>
          <dd class="mono">{{ fmtAbsolute(event.createdDateTime) }}</dd>
          <dt>Application</dt>
          <dd>
            {{ event.appDisplayName ?? '—'
            }}<span v-if="event.appId" class="ev-id mono"> · {{ event.appId }}</span>
          </dd>
          <dt>Source IP</dt>
          <dd class="mono">
            {{ event.ipAddress ?? '—' }}
            <span v-if="event.ipAddress" class="ev-id">({{ ipKindLabel(event.ipAddress) }})</span>
          </dd>
          <dt>Location</dt>
          <dd>{{ locationLabel(event) }}</dd>
          <dt>Client</dt>
          <dd>{{ event.clientAppUsed ?? '—' }}</dd>
          <dt>Interactive</dt>
          <dd>{{ event.isInteractive === null ? '—' : event.isInteractive ? 'yes' : 'no' }}</dd>
        </dl>
      </section>

      <section class="ev-section">
        <h4 class="ev-h">Authentication</h4>
        <dl class="ev-grid">
          <dt>Methods used</dt>
          <dd>
            <span v-if="event.authenticationMethods.length === 0">—</span>
            <ul v-else class="ev-list">
              <li v-for="m in event.authenticationMethods" :key="m">
                <i class="pi pi-lock" /> {{ m }}
              </li>
            </ul>
          </dd>
          <dt>Conditional Access</dt>
          <dd>{{ event.conditionalAccessStatus ?? '—' }}</dd>
          <dt>Risk state</dt>
          <dd>{{ event.riskState ?? '—' }}</dd>
          <dt>Risk level</dt>
          <dd>{{ event.riskLevel ?? '—' }}</dd>
        </dl>
      </section>

      <section v-if="event.device" class="ev-section">
        <h4 class="ev-h">Device</h4>
        <dl class="ev-grid">
          <dt>OS</dt>
          <dd>{{ event.device.os ?? '—' }}</dd>
          <dt>Browser</dt>
          <dd>{{ event.device.browser ?? '—' }}</dd>
          <dt>Trust type</dt>
          <dd>{{ event.device.trustType ?? '—' }}</dd>
        </dl>
      </section>

      <section v-if="event.status?.failureReason" class="ev-section">
        <h4 class="ev-h">Failure</h4>
        <dl class="ev-grid">
          <dt>Code</dt>
          <dd class="mono">{{ event.status.errorCode }}</dd>
          <dt>Reason</dt>
          <dd>{{ event.status.failureReason }}</dd>
        </dl>
      </section>

      <!-- Catch-all: every Graph field we didn't promote to a column.
           Pretty-printed JSON because an operator debugging "why did
           this CA policy fire" needs to see the structured array. -->
      <section class="ev-section">
        <h4 class="ev-h">Raw event payload</h4>
        <p class="ev-help">
          Fields not promoted into the typed columns above. Source: Microsoft Graph
          <code>/auditLogs/signIns</code>.
        </p>
        <pre class="ev-json mono">{{ prettyDetail }}</pre>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
.ev-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ev-loading {
  padding: 14px 4px;
  color: var(--text-3);
  font-size: 13px;
}

.ev-hero {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
}

.ev-hero-title {
  display: flex;
  flex-direction: column;
}

.ev-hero-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.ev-hero-upn {
  font-size: 12px;
  color: var(--text-3);
}

.ev-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ev-h {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.ev-help {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}

.ev-help code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 11px;
}

.ev-grid {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 12.5px;
}

.ev-grid dt {
  color: var(--text-3);
}

.ev-grid dd {
  margin: 0;
  color: var(--text);
}

.ev-id {
  color: var(--text-3);
  font-size: 11px;
}

.ev-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
}

.ev-json {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.5;
  max-height: 320px;
  overflow: auto;
  margin: 0;
  color: var(--text-2);
}
</style>
