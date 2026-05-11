<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import type { AuditEventRow } from '../../api/index.js';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';
import EmptyState from './EmptyState.vue';

const props = defineProps<{
  events: AuditEventRow[];
  loading?: boolean;
}>();

interface FeedItem {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  iconClass: string;
  toneClass: string;
  actor: string;
}

const FRIENDLY_ACTION: Record<string, { title: string; iconClass: string; tone: string }> = {
  'user.view': { title: 'Account viewed', iconClass: 'pi pi-eye', tone: 'tone-muted' },
  'user.update': { title: 'Attributes updated', iconClass: 'pi pi-pencil', tone: 'tone-blue' },
  'user.unlock': { title: 'Account unlocked', iconClass: 'pi pi-lock-open', tone: 'tone-green' },
  'user.disable': { title: 'Account disabled', iconClass: 'pi pi-ban', tone: 'tone-amber' },
  'user.enable': { title: 'Account enabled', iconClass: 'pi pi-check-circle', tone: 'tone-green' },
  'user.password.reset': {
    title: 'Password reset',
    iconClass: 'pi pi-key',
    tone: 'tone-amber',
  },
  'user.group.add': { title: 'Added to group', iconClass: 'pi pi-plus', tone: 'tone-blue' },
  'user.group.remove': { title: 'Removed from group', iconClass: 'pi pi-minus', tone: 'tone-blue' },
  'user.move': { title: 'Moved to OU', iconClass: 'pi pi-folder', tone: 'tone-blue' },
};

const items = computed<FeedItem[]>(() =>
  props.events.map((e) => {
    const meta = FRIENDLY_ACTION[e.action] ?? {
      title: e.action,
      iconClass: 'pi pi-circle',
      tone: 'tone-muted',
    };
    let tone = meta.tone;
    if (e.result === 'failure' || e.result === 'denied') tone = 'tone-red';
    return {
      id: e.id,
      title: meta.title,
      detail: detailFor(e),
      timestamp: e.timestamp,
      iconClass: meta.iconClass,
      toneClass: tone,
      actor: e.actorDisplayName ?? e.actorUserId ?? 'system',
    };
  }),
);

function detailFor(e: AuditEventRow): string {
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  if (e.action === 'user.update' && md.fields) {
    return `Fields: ${Array.isArray(md.fields) ? md.fields.join(', ') : String(md.fields)}`;
  }
  if (e.action === 'user.group.add' || e.action === 'user.group.remove') {
    if (md.groupName) return `Group: ${String(md.groupName)}`;
  }
  if (e.action === 'user.move' && md.targetOu) {
    return `To: ${String(md.targetOu)}`;
  }
  if (e.result !== 'success') {
    return e.errorCode ? `Failed (${e.errorCode})` : 'Failed';
  }
  return '';
}
</script>

<template>
  <div class="af">
    <div v-if="loading" class="af-loading">Loading…</div>
    <EmptyState
      v-else-if="items.length === 0"
      icon="pi pi-clock"
      title="No recent activity"
      description="Actions taken on this account will appear here."
    />
    <ol v-else class="af-list">
      <li v-for="item in items" :key="item.id" class="af-item">
        <span class="af-bullet" :class="item.toneClass">
          <i :class="item.iconClass" />
        </span>
        <div class="af-body">
          <div class="af-row">
            <span class="af-title">{{ item.title }}</span>
            <span class="af-time" :title="fmtAbsolute(item.timestamp)">
              {{ fmtRelative(item.timestamp) }}
            </span>
          </div>
          <div v-if="item.detail" class="af-detail">{{ item.detail }}</div>
          <div class="af-actor">by {{ item.actor }}</div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.af-loading {
  padding: 16px;
  font-size: 13px;
  color: var(--text-3);
}

.af-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.af-item {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  position: relative;
}

.af-item:last-child {
  border-bottom: none;
}

.af-bullet {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 12px;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}

.af-bullet.tone-green {
  background: color-mix(in oklab, var(--green) 18%, transparent);
  color: var(--green);
  border-color: color-mix(in oklab, var(--green) 35%, transparent);
}
.af-bullet.tone-amber {
  background: color-mix(in oklab, var(--amber) 18%, transparent);
  color: var(--amber);
  border-color: color-mix(in oklab, var(--amber) 35%, transparent);
}
.af-bullet.tone-red {
  background: color-mix(in oklab, var(--red) 18%, transparent);
  color: var(--red);
  border-color: color-mix(in oklab, var(--red) 35%, transparent);
}
.af-bullet.tone-blue {
  background: color-mix(in oklab, var(--blue) 18%, transparent);
  color: var(--blue);
  border-color: color-mix(in oklab, var(--blue) 35%, transparent);
}

.af-body {
  flex: 1;
  min-width: 0;
}

.af-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.af-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.af-time {
  font-size: 11.5px;
  font-family: var(--font-mono);
  color: var(--text-3);
  flex-shrink: 0;
}

.af-detail {
  font-size: 12.5px;
  color: var(--text-2);
  margin-top: 2px;
}

.af-actor {
  font-size: 11.5px;
  font-family: var(--font-mono);
  color: var(--text-3);
  margin-top: 2px;
}
</style>
