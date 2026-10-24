<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!-- Step 2: what each column is, guessed from its header, with the first rows under it. -->
<script setup lang="ts">
import Message from 'primevue/message';
import Select from 'primevue/select';
import type { ImportField } from '@openaduc/shared';
import type { useUserImport } from '../../design/composables/useUserImport.js';

const props = defineProps<{ wizard: ReturnType<typeof useUserImport> }>();
const { draft, table, fieldOptions, columnProblems, preview } = props.wizard;
</script>

<template>
  <div class="cols">
    <p class="cols-intro">
      Each column is guessed from its header. Fix any that are wrong, or leave a column out. First
      and last name are needed; nothing else is.
    </p>
    <div class="cols-scroll">
      <table class="cols-table">
        <thead>
          <tr>
            <th v-for="(header, i) in table?.header ?? []" :key="i" scope="col">
              <span class="cols-header" :title="header">{{ header || `Column ${i + 1}` }}</span>
              <Select
                :model-value="draft.mapping[i] ?? null"
                :options="fieldOptions"
                option-label="label"
                option-value="value"
                :aria-label="`Import ${header || `column ${i + 1}`} as`"
                size="small"
                fluid
                :class="{ 'cols-left-out': !draft.mapping[i] }"
                @update:model-value="(f: ImportField | null) => wizard.setMapping(i, f)"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in preview" :key="r">
            <td v-for="(cell, i) in row" :key="i" :class="{ 'cols-left-out': !draft.mapping[i] }">
              {{ cell }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="(table?.rows.length ?? 0) > preview.length" class="hint">
      The first {{ preview.length }} of {{ table?.rows.length }} rows.
    </p>
    <Message
      v-for="p in columnProblems"
      :key="p"
      severity="error"
      :closable="false"
      class="cols-msg"
    >
      {{ p }}
    </Message>
  </div>
</template>

<style scoped>
.cols-intro {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-2);
}

.cols-scroll {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.cols-table {
  border-collapse: collapse;
  font-size: 12.5px;
  min-width: 100%;
}

.cols-table th,
.cols-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-soft);
  text-align: left;
  vertical-align: top;
  min-width: 10rem;
  max-width: 16rem;
}

.cols-table th {
  background: var(--surface-2);
  font-weight: 500;
}

.cols-table td {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cols-header {
  display: block;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

td.cols-left-out {
  color: var(--text-4);
}

.cols-msg {
  margin: 8px 0 0;
}
</style>
