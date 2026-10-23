<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Dialog from 'primevue/dialog';
import { SHORTCUT_KEYS } from '../lib/shortcutKeys.js';
import {
  SHORTCUT_SECTIONS,
  onShortcutKey,
  shortcuts,
  useShortcuts,
} from '../composables/useShortcuts.js';

// Mounted once by the shell, where the page's shortcuts should work: it
// listens for them, and `?` lists them.

const open = ref(false);

useShortcuts(() => [
  {
    key: SHORTCUT_KEYS.general.help,
    label: 'Show keyboard shortcuts',
    section: 'General',
    run: () => {
      open.value = true;
    },
  },
]);

const sections = computed(() =>
  SHORTCUT_SECTIONS.map((title) => ({
    title,
    items: shortcuts.value.filter((s) => s.section === title),
  })).filter((sec) => sec.items.length > 0),
);

onMounted(() => window.addEventListener('keydown', onShortcutKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onShortcutKey));
</script>

<template>
  <Dialog
    v-model:visible="open"
    modal
    header="Keyboard shortcuts"
    :style="{ width: '26rem' }"
    :pt="{ root: { 'aria-describedby': 'shortcut-sheet-note' } }"
  >
    <p id="shortcut-sheet-note" class="sheet-note">
      Shortcuts on this page. They don’t work while you’re typing in a field.
    </p>
    <section v-for="sec in sections" :key="sec.title" class="sheet-section">
      <h3 class="sheet-title">{{ sec.title }}</h3>
      <dl class="sheet-list">
        <div
          v-for="s in sec.items"
          :key="s.key"
          class="sheet-row"
          :class="{ 'is-unavailable': s.unavailable }"
        >
          <dt>
            <kbd class="kbd">{{ s.key }}</kbd>
          </dt>
          <dd>
            {{ s.label }}
            <span v-if="s.unavailable" class="sheet-why">({{ s.unavailable }})</span>
          </dd>
        </div>
      </dl>
    </section>
  </Dialog>
</template>

<style scoped>
.sheet-note {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--text-3);
}

.sheet-section + .sheet-section {
  margin-top: 14px;
}

.sheet-title {
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.sheet-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sheet-row {
  display: grid;
  grid-template-columns: 4.5rem 1fr;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  color: var(--text);
}

.sheet-row dt,
.sheet-row dd {
  margin: 0;
}

.sheet-row.is-unavailable {
  color: var(--text-3);
}

.sheet-why {
  font-size: 12px;
}
</style>
