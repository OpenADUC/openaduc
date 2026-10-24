<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  An import's page as tabs: its people, as its operator follows the run,
  and its class roster, which any operator who may issue a TAP can open.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router';

defineProps<{
  id: string;
  active: 'people' | 'roster';
  /** The People tab is the import's operator's alone. */
  people: boolean;
  roster: boolean;
}>();
</script>

<template>
  <nav class="ds-tabs" aria-label="Import">
    <RouterLink
      v-if="people"
      :to="{ name: 'user-import-job', params: { id } }"
      class="ds-tab"
      :class="{ active: active === 'people' }"
      :aria-current="active === 'people' ? 'page' : undefined"
    >
      <i class="pi pi-users" /> People
    </RouterLink>
    <RouterLink
      v-if="roster"
      :to="{ name: 'user-import-roster', params: { id } }"
      class="ds-tab"
      :class="{ active: active === 'roster' }"
      :aria-current="active === 'roster' ? 'page' : undefined"
    >
      <i class="pi pi-id-card" /> Class roster
    </RouterLink>
  </nav>
</template>

<style scoped>
/* As the audit log's and Settings' tab strips. */
.ds-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.ds-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
  position: relative;
  border-radius: 6px 6px 0 0;
  text-decoration: none;
}

.ds-tab:hover,
.ds-tab.active {
  color: var(--text);
}

.ds-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}
</style>
