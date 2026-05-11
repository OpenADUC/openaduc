<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ dn: string | null | undefined }>();

const copied = ref(false);

async function copyDn(): Promise<void> {
  if (!props.dn) return;
  try {
    await navigator.clipboard.writeText(props.dn);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // clipboard may be unavailable; silently ignore.
  }
}
</script>

<template>
  <div v-if="dn" class="ds-dn">
    <span class="ds-dn-text">{{ dn }}</span>
    <button
      class="ds-dn-copy"
      type="button"
      :title="copied ? 'Copied!' : 'Copy DN'"
      @click="copyDn"
    >
      <i :class="copied ? 'pi pi-check' : 'pi pi-copy'" />
    </button>
  </div>
  <span v-else class="ds-dn-empty">—</span>
</template>

<style scoped>
.ds-dn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-3);
  word-break: break-all;
  max-width: 100%;
}

.ds-dn-text {
  flex: 1;
  min-width: 0;
}

.ds-dn-copy {
  background: transparent;
  border: 0;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 11px;
  flex-shrink: 0;
}

.ds-dn-copy:hover {
  background: var(--hover);
  color: var(--text);
}

.ds-dn-empty {
  color: var(--text-4);
  font-family: var(--font-mono);
  font-size: 11.5px;
}
</style>
