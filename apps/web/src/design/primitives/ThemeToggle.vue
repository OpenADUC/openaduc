<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '../stores/useTheme.js';

const theme = useThemeStore();
const isDark = computed(() => theme.mode === 'dark');
const label = computed(() => (isDark.value ? 'Switch to light mode' : 'Switch to dark mode'));
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :title="label"
    :aria-label="label"
    @click="theme.toggleMode()"
  >
    <i :class="isDark ? 'pi pi-sun' : 'pi pi-moon'" />
  </button>
</template>

<style scoped>
.theme-toggle {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--text-2);
  font-size: 14px;
  transition:
    background 120ms ease,
    color 120ms ease,
    border-color 120ms ease;
}

.theme-toggle:hover {
  background: var(--hover);
  color: var(--text);
  border-color: var(--border);
}

.theme-toggle:focus-visible {
  outline: none;
  border-color: var(--accent);
}
</style>
