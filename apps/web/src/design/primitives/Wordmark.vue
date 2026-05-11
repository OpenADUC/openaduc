<script setup lang="ts">
withDefaults(
  defineProps<{
    /** HTML element to render as. Defaults to <span>. */
    as?: string;
    /** Render only the acronym half ("ADUC") — useful for tight spaces. */
    compact?: boolean;
  }>(),
  { as: 'span', compact: false },
);
</script>

<template>
  <component :is="as" class="ds-wordmark" :class="{ 'is-compact': compact }">
    <span v-if="!compact" class="ds-wordmark-prefix">Open</span><span class="ds-wordmark-acronym">ADUC</span>
  </component>
</template>

<style scoped>
.ds-wordmark {
  font-family: var(--font-sans);
  font-weight: 500;
  letter-spacing: -0.02em;
  white-space: nowrap;
  line-height: 1;
  color: inherit;
  display: inline-flex;
  align-items: baseline;
}

.ds-wordmark-prefix {
  font-weight: 500;
}

.ds-wordmark-acronym {
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.01em;
}
</style>
