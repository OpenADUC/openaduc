<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { initialsFor } from '../lib/format.js';

const props = defineProps<{
  name: string;
  nested?: boolean;
  sensitive?: boolean;
  removable?: boolean;
  /** Optional vue-router target — when set, the chip renders as a link. */
  to?: string | { name: string; params?: Record<string, string> };
}>();

defineEmits<{ (e: 'remove'): void }>();

const initial = computed(() => {
  if (props.nested) return '';
  return initialsFor(props.name);
});
</script>

<template>
  <RouterLink
    v-if="to"
    :to="to"
    class="gchip linkable"
    :class="{ nested }"
    :title="nested ? 'Inherited via nested group · open detail' : 'Open group detail'"
  >
    <span class="gchip-icon">{{ nested ? '⤴' : initial }}</span>
    <span :style="sensitive ? { color: 'var(--red)' } : undefined">{{ name }}</span>
    <span v-if="removable" class="gchip-x" @click.prevent.stop="$emit('remove')">
      <i class="pi pi-times" />
    </span>
  </RouterLink>
  <span
    v-else
    class="gchip"
    :class="{ nested }"
    :title="nested ? 'Inherited via nested group' : ''"
  >
    <span class="gchip-icon">{{ nested ? '⤴' : initial }}</span>
    <span :style="sensitive ? { color: 'var(--red)' } : undefined">{{ name }}</span>
    <span v-if="removable" class="gchip-x" @click="$emit('remove')">
      <i class="pi pi-times" />
    </span>
  </span>
</template>

<style scoped>
/* Both variants share the .gchip class from theme.css; this scoped block
 * just adds the link-specific affordances. */
.gchip.linkable {
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s,
    color 0.12s;
}

.gchip.linkable:hover {
  background: var(--surface-3);
  border-color: var(--border-strong);
  color: var(--text);
}
</style>
