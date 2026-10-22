<!-- SPDX-License-Identifier: BUSL-1.1
     "Synced 5m ago" next to a cached list, or a warning when its sync is
     overdue, so operators know how far to trust what they're looking at. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { ListFreshness } from '@openaduc/shared';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';

const props = defineProps<{ freshness: ListFreshness | null }>();

const text = computed(() => {
  const f = props.freshness;
  if (!f) return '';
  if (!f.lastSyncedAt) return 'Not synced yet';
  const ago = fmtRelative(f.lastSyncedAt);
  return f.stale ? `Sync overdue · last ${ago}` : `Synced ${ago}`;
});
</script>

<template>
  <span
    v-if="freshness"
    class="sync-freshness"
    :class="{ stale: freshness.stale }"
    :title="
      freshness.lastSyncedAt ? `Last synced ${fmtAbsolute(freshness.lastSyncedAt)}` : undefined
    "
    role="status"
  >
    <i :class="freshness.stale ? 'pi pi-exclamation-triangle' : 'pi pi-sync'" aria-hidden="true" />
    {{ text }}
  </span>
</template>

<style scoped>
.sync-freshness {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
.sync-freshness.stale {
  color: var(--amber);
  font-weight: 600;
}
</style>
