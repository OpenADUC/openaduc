<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import { RouterLink } from 'vue-router';
import type { AuditEventRow } from '../../api/index.js';
import Avatar from '../primitives/Avatar.vue';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';

const props = defineProps<{
  visible: boolean;
  event: AuditEventRow | null;
}>();

const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>();

function close(): void {
  emit('update:visible', false);
}

const actorLabel = computed(() => {
  if (!props.event) return '';
  return (
    props.event.actorDisplayName ??
    (props.event.actorUserId ? `actor ${props.event.actorUserId}` : 'system')
  );
});

const resultBadge = computed(() => {
  if (!props.event) return 'badge-muted';
  if (props.event.result === 'success') return 'badge-green';
  if (props.event.result === 'failure' || props.event.result === 'denied') return 'badge-red';
  return 'badge-amber';
});

const targetLink = computed(() => {
  if (!props.event?.targetType || !props.event?.targetId) return null;
  if (props.event.targetType === 'user') {
    return { name: 'user-detail', params: { id: props.event.targetId } };
  }
  if (props.event.targetType === 'group') {
    return { name: 'group-detail', params: { id: props.event.targetId } };
  }
  return null;
});

// Parse the event's `before`/`after` payloads into a sorted list of fields
// so the diff is easy to scan. Returns one row per key from either side.
const diffRows = computed(() => {
  const before = (props.event?.before ?? {}) as Record<string, unknown>;
  const after = (props.event?.after ?? {}) as Record<string, unknown>;
  if (!props.event?.before && !props.event?.after) return [];
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      before: key in before ? before[key] : undefined,
      after: key in after ? after[key] : undefined,
      changed: JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    }));
});

// Pretty-print metadata as a sorted list of {key, value} rows.
const metadataRows = computed(() => {
  const meta = props.event?.metadata;
  if (!meta || typeof meta !== 'object') return [];
  const obj = meta as Record<string, unknown>;
  return Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
});

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function actionTone(action: string, result: string): 'green' | 'red' | 'amber' | 'blue' | 'muted' {
  if (result === 'failure' || result === 'denied') return 'red';
  if (action.startsWith('auth.')) return 'blue';
  if (action.startsWith('user.') || action.startsWith('group.')) return 'green';
  if (action.startsWith('sync.')) return 'amber';
  return 'muted';
}

function actionIcon(action: string): string {
  if (action.startsWith('auth.')) return 'pi pi-sign-in';
  if (action.includes('unlock')) return 'pi pi-unlock';
  if (action.includes('lock')) return 'pi pi-lock';
  if (action.includes('view')) return 'pi pi-eye';
  if (action.includes('search')) return 'pi pi-search';
  if (action.includes('disable')) return 'pi pi-ban';
  if (action.includes('enable')) return 'pi pi-check';
  if (action.includes('reset')) return 'pi pi-key';
  if (action.includes('group')) return 'pi pi-users';
  if (action.includes('update')) return 'pi pi-pencil';
  if (action.startsWith('sync.')) return 'pi pi-refresh';
  if (action.startsWith('settings.')) return 'pi pi-cog';
  if (action.startsWith('directory.')) return 'pi pi-server';
  return 'pi pi-circle-fill';
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="true"
    :style="{ width: '40rem' }"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <template #header>
      <div class="dlg-header">
        <span
          class="dlg-action-icon"
          :class="event ? `badge-${actionTone(event.action, event.result)}` : ''"
        >
          <i :class="event ? actionIcon(event.action) : 'pi pi-circle'" />
        </span>
        <div class="dlg-header-text">
          <div class="dlg-title mono">{{ event?.action ?? '' }}</div>
          <div class="dlg-subtitle">
            <span class="badge" :class="resultBadge">{{ event?.result ?? '' }}</span>
            <span class="dlg-when mono">
              {{ event ? fmtAbsolute(event.timestamp) : '' }}
              <span class="dlg-when-rel">· {{ event ? fmtRelative(event.timestamp) : '' }}</span>
            </span>
          </div>
        </div>
      </div>
    </template>

    <div v-if="event" class="dlg-body">
      <!-- Actor -->
      <section class="dlg-section">
        <div class="dlg-section-label">Actor</div>
        <div class="dlg-actor-row">
          <Avatar :name="actorLabel" :seed="event.actorUserId ?? actorLabel" :size="28" />
          <div class="dlg-actor-meta">
            <div class="dlg-actor-name">{{ actorLabel }}</div>
            <div v-if="event.actorUserId" class="dlg-actor-id mono">{{ event.actorUserId }}</div>
            <div v-if="event.actorAuthMethod" class="dlg-actor-method mono">
              auth method: {{ event.actorAuthMethod }}
            </div>
          </div>
        </div>
      </section>

      <!-- Request context -->
      <section
        v-if="event.sourceIp || event.userAgent || event.correlationId || event.sessionId"
        class="dlg-section"
      >
        <div class="dlg-section-label">Request</div>
        <dl class="dlg-kv">
          <template v-if="event.sourceIp">
            <dt>Source IP</dt>
            <dd class="mono">{{ event.sourceIp }}</dd>
          </template>
          <template v-if="event.userAgent">
            <dt>User-Agent</dt>
            <dd class="mono dlg-ua">{{ event.userAgent }}</dd>
          </template>
          <template v-if="event.correlationId">
            <dt>Correlation</dt>
            <dd class="mono">{{ event.correlationId }}</dd>
          </template>
          <template v-if="event.sessionId">
            <dt>Session</dt>
            <dd class="mono">{{ event.sessionId }}</dd>
          </template>
        </dl>
      </section>

      <!-- Target -->
      <section v-if="event.targetType || event.targetDn" class="dlg-section">
        <div class="dlg-section-label">Target</div>
        <dl class="dlg-kv">
          <dt>Type</dt>
          <dd class="mono">{{ event.targetType ?? '—' }}</dd>
          <template v-if="event.targetId">
            <dt>ID</dt>
            <dd class="mono">
              <RouterLink v-if="targetLink" :to="targetLink" class="dlg-link" @click="close">
                {{ event.targetId }}
              </RouterLink>
              <span v-else>{{ event.targetId }}</span>
            </dd>
          </template>
          <template v-if="event.targetDn">
            <dt>DN</dt>
            <dd class="mono dlg-dn">{{ event.targetDn }}</dd>
          </template>
        </dl>
      </section>

      <!-- Error code (failures only) -->
      <section v-if="event.errorCode" class="dlg-section">
        <div class="dlg-section-label">Error</div>
        <div class="dlg-error mono">{{ event.errorCode }}</div>
      </section>

      <!-- Metadata -->
      <section v-if="metadataRows.length > 0" class="dlg-section">
        <div class="dlg-section-label">Metadata</div>
        <dl class="dlg-kv wide">
          <template v-for="row in metadataRows" :key="row.key">
            <dt class="mono">{{ row.key }}</dt>
            <dd>
              <pre class="dlg-val mono">{{ fmtValue(row.value) }}</pre>
            </dd>
          </template>
        </dl>
      </section>

      <!-- Before / After diff -->
      <section v-if="diffRows.length > 0" class="dlg-section">
        <div class="dlg-section-label">Before / After</div>
        <table class="dlg-diff">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in diffRows" :key="row.key" :class="{ changed: row.changed }">
              <td class="mono">{{ row.key }}</td>
              <td>
                <pre class="dlg-val mono">{{ fmtValue(row.before) }}</pre>
              </td>
              <td>
                <pre class="dlg-val mono">{{ fmtValue(row.after) }}</pre>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <template #footer>
      <Button label="Close" severity="secondary" text @click="close" />
    </template>
  </Dialog>
</template>

<style scoped>
.dlg-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.dlg-action-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid;
  font-size: 12px;
  flex: 0 0 28px;
}

.dlg-header-text {
  min-width: 0;
}

.dlg-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.dlg-subtitle {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 2px;
  font-size: 12px;
}

.dlg-when {
  color: var(--text-3);
}

.dlg-when-rel {
  color: var(--text-4);
}

.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dlg-section-label {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-bottom: 6px;
}

.dlg-actor-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dlg-actor-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.dlg-actor-id {
  font-size: 11px;
  color: var(--text-3);
}

.dlg-kv {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 12.5px;
}

.dlg-kv dt {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.dlg-kv dd {
  margin: 0;
  color: var(--text);
}

.dlg-kv.wide {
  grid-template-columns: 140px 1fr;
}

.dlg-actor-method {
  font-size: 11px;
  color: var(--text-3);
}

.dlg-ua {
  word-break: break-all;
  font-size: 11px;
}

.dlg-dn {
  word-break: break-all;
  font-size: 11.5px;
  color: var(--text-2);
}

.dlg-link {
  color: var(--accent);
  text-decoration: none;
}

.dlg-link:hover {
  text-decoration: underline;
}

.dlg-error {
  background: var(--red-soft);
  border: 1px solid color-mix(in oklab, var(--red) 22%, transparent);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--red);
  font-size: 12px;
}

.dlg-diff {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.dlg-diff thead th {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
  font-weight: 500;
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.dlg-diff td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.dlg-diff tr.changed td:nth-child(2) {
  background: color-mix(in oklab, var(--red) 5%, transparent);
}

.dlg-diff tr.changed td:nth-child(3) {
  background: color-mix(in oklab, var(--green) 5%, transparent);
}

.dlg-val {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11.5px;
  color: var(--text);
  max-height: 160px;
  overflow: auto;
}
</style>
