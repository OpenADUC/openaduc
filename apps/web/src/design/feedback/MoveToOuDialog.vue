<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Move a user or computer to another OU: a TreeSelect over the directory's
  OUs with the current one preselected, so the operator sees where it is
  before picking a destination. Renders a useAccountMove the page owns, so
  the page can show a failed Undo and say where the account went.
-->
<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Message from 'primevue/message';
import TreeSelect from 'primevue/treeselect';
import type { TreeNode } from 'primevue/treenode';
import type { AccountKind } from '../composables/useAccountActions.js';
import type { MoveFailure, useAccountMove } from '../composables/useAccountMove.js';
import { ouTreeNodes } from '../lib/ouTree.js';

const props = defineProps<{
  visible: boolean;
  move: ReturnType<typeof useAccountMove>;
  kind: AccountKind;
  name: string;
  /** The failed move to show here, as placeFailure places it. */
  failure: MoveFailure | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { ous, loading, currentOuDn, destination, atCurrent, ready, submitting, error } = props.move;

// PrimeVue TreeSelect keys its single selection by node key, which is the DN.
const selection = computed<Record<string, boolean>>({
  get: () => (destination.value ? { [destination.value]: true } : {}),
  set: (keys) => (destination.value = Object.keys(keys).find((k) => keys[k]) ?? null),
});

const tree = computed<TreeNode[]>(() => ouTreeNodes(ous.value));
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Move to OU"
    :style="{ width: '34rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && emit('close')"
  >
    <p class="dialog-prose primary">
      Move <strong>{{ name }}</strong> to a different organizational unit.
    </p>
    <p class="dialog-prose secondary">
      The {{ kind }}'s name stays the same — only the parent container changes. Group memberships
      and the {{ kind }}'s GUID are preserved.
    </p>
    <div v-if="currentOuDn" class="move-current">
      <span class="muted">Currently in:</span>
      <code class="dn-line">{{ currentOuDn }}</code>
    </div>
    <div class="move-tree">
      <div v-if="loading" class="hint">Loading OUs…</div>
      <TreeSelect
        v-else
        v-model="selection"
        :options="tree"
        selection-mode="single"
        placeholder="Pick a destination OU"
        fluid
        :disabled="submitting"
      />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-else-if="failure" severity="error" closable @close="move.dismiss">
      {{ failure.message }}
    </Message>
    <Message v-else-if="atCurrent" severity="info" :closable="false">
      That's the {{ kind }}'s current OU — pick a different one.
    </Message>
    <template #footer>
      <Button
        label="Cancel"
        text
        severity="secondary"
        :disabled="submitting"
        @click="emit('close')"
      />
      <Button
        label="Move"
        icon="pi pi-folder-open"
        :loading="submitting"
        :disabled="!ready"
        @click="move.submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.dialog-prose {
  font-size: 13px;
  margin: 0 0 8px;
}

.dialog-prose.primary {
  color: var(--text);
}

.dialog-prose.secondary {
  color: var(--text-3);
  font-size: 12px;
  margin-bottom: 14px;
}

.move-current {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 12px;
}

.move-current .muted {
  color: var(--text-3);
}

.dn-line {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  color: var(--text-2);
  word-break: break-all;
}

.move-tree {
  margin: 0 0 12px;
  min-height: 40px;
}
</style>
