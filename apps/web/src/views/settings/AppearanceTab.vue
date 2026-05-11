<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import {
  useThemeStore,
  ACCENTS,
  type ThemeMode,
  type Density,
  type AccentName,
} from '../../design/stores/useTheme.js';
import Card from '../../design/primitives/Card.vue';

const theme = useThemeStore();

const modes: { value: ThemeMode; label: string; sub: string }[] = [
  { value: 'dark', label: 'Dark', sub: 'recommended for IT operators' },
  { value: 'light', label: 'Light', sub: 'classic surface' },
];

const densities: { value: Density; label: string; sub: string }[] = [
  { value: 'compact', label: 'Compact', sub: 'maximize information' },
  { value: 'balanced', label: 'Balanced', sub: 'default' },
  { value: 'comfy', label: 'Comfy', sub: 'easier on the eyes' },
];

const accentNames = Object.keys(ACCENTS) as AccentName[];
</script>

<template>
  <Card>
    <div class="settings-row">
      <div class="settings-label">
        <div class="setting-name">Theme</div>
      </div>
      <div class="settings-control">
        <button
          v-for="m in modes"
          :key="m.value"
          type="button"
          class="seg"
          :class="{ active: theme.mode === m.value }"
          @click="theme.setMode(m.value)"
        >
          <i :class="m.value === 'dark' ? 'pi pi-moon' : 'pi pi-sun'" />
          {{ m.label }}
        </button>
      </div>
    </div>

    <div class="settings-divider" />

    <div class="settings-row">
      <div class="settings-label">
        <div class="setting-name">Density</div>
      </div>
      <div class="settings-control">
        <button
          v-for="d in densities"
          :key="d.value"
          type="button"
          class="seg"
          :class="{ active: theme.density === d.value }"
          @click="theme.setDensity(d.value)"
        >
          {{ d.label }}
        </button>
      </div>
    </div>

    <div class="settings-divider" />

    <div class="settings-row">
      <div class="settings-label">
        <div class="setting-name">Accent</div>
      </div>
      <div class="settings-control accent-row">
        <button
          v-for="a in accentNames"
          :key="a"
          type="button"
          class="accent-swatch"
          :class="{ active: theme.accent === a }"
          :style="{ background: ACCENTS[a].color }"
          :title="a"
          :aria-label="a"
          @click="theme.setAccent(a)"
        />
      </div>
    </div>
  </Card>
</template>

<style scoped>
.settings-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: center;
  padding: 12px 0;
}

.settings-label .setting-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.settings-control {
  display: flex;
  gap: 4px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 3px;
}

.seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  border-radius: 5px;
  cursor: pointer;
  font-family: var(--font-sans);
}

.seg:hover {
  color: var(--text);
}

.seg.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.settings-divider {
  height: 1px;
  background: var(--border);
}

.accent-row {
  background: transparent;
  border: 0;
  padding: 0;
  gap: 8px;
}

.accent-swatch {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition:
    transform 0.12s,
    border-color 0.12s;
}

.accent-swatch:hover {
  transform: scale(1.05);
}

.accent-swatch.active {
  border-color: var(--text);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--text) 8%, transparent);
}
</style>
