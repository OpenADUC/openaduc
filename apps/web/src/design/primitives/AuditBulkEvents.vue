<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { api, type AuditEventRow } from '../../api/index.js';
import { fmtAbsolute } from '../lib/format.js';

// The events of one bulk job, listed under its entry in the audit log.
const props = defineProps<{ bulkJobId: string }>();
const emit = defineEmits<{ select: [event: AuditEventRow] }>();

const PAGE_SIZE = 100;
const events = ref<AuditEventRow[]>([]);
const total = ref(0);
const page = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

async function loadMore(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await api.audit.list({
      bulkJobId: props.bulkJobId,
      page: page.value + 1,
      pageSize: PAGE_SIZE,
    });
    events.value = [...events.value, ...r.rows];
    total.value = r.total;
    page.value += 1;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load the job’s events';
  } finally {
    loading.value = false;
  }
}

const resultClass = (r: string) =>
  r === 'success' ? 'badge-green' : r === 'failure' || r === 'denied' ? 'badge-red' : 'badge-muted';

onMounted(loadMore);
</script>

<template>
  <div class="bulk-events">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <table class="bulk-events-table">
      <tbody>
        <tr v-for="e in events" :key="e.id" class="bulk-event" @click="emit('select', e)">
          <td class="mono bulk-event-time">{{ fmtAbsolute(e.timestamp) }}</td>
          <td class="mono">{{ e.action }}</td>
          <td class="mono">
            <span class="bulk-event-target">{{ e.targetDn ?? e.targetId ?? '—' }}</span>
          </td>
          <td>
            <span class="badge" :class="resultClass(e.result)">
              <span class="badge-dot" />
              {{ e.result }}
            </span>
          </td>
          <td class="mono bulk-event-error">{{ e.errorCode ?? '' }}</td>
        </tr>
      </tbody>
    </table>
    <Button
      v-if="events.length < total"
      :label="`Show more (${total - events.length} left)`"
      size="small"
      text
      :loading="loading"
      @click="loadMore"
    />
  </div>
</template>

<style scoped>
.bulk-events {
  padding: 4px 0 8px 32px;
}

.bulk-events-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.bulk-event {
  cursor: pointer;
}

.bulk-event:hover {
  background: var(--surface-2);
}

.bulk-event td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.bulk-event-target {
  display: inline-block;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  color: var(--text-3);
}

.bulk-event-error {
  color: var(--text-3);
}

.bulk-event-time {
  width: 170px;
  white-space: nowrap;
}
</style>
