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
