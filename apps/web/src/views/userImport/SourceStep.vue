<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!-- Step 1: rows pasted from a spreadsheet, or a CSV file dropped or picked. -->
<script setup lang="ts">
import { ref } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Textarea from 'primevue/textarea';
import { IMPORT_MAX_ROWS } from '@openaduc/shared';
import {
  IMPORT_TEMPLATE_FILE,
  type useUserImport,
} from '../../design/composables/useUserImport.js';

const props = defineProps<{ wizard: ReturnType<typeof useUserImport> }>();
const { draft, table, sourceError, sourceProblems, headerMissing } = props.wizard;

const text = ref('');
const dragging = ref(false);
const picker = ref<HTMLInputElement | null>(null);

const DELIMITER_NAME: Record<string, string> = {
  '\t': 'tabs',
  ',': 'commas',
  ';': 'semicolons',
  '|': 'pipes',
};

function onPaste(): void {
  props.wizard.paste(text.value);
  text.value = '';
}

// Rows pasted from Excel are used at once; typed text waits for the button.
function onClipboard(e: ClipboardEvent): void {
  const pasted = e.clipboardData?.getData('text/plain') ?? '';
  if (!pasted.trim() || text.value.trim()) return;
  e.preventDefault();
  props.wizard.paste(pasted);
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void props.wizard.readFile(file);
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void props.wizard.readFile(file);
  input.value = '';
}

function downloadTemplate(): void {
  const blob = new Blob([props.wizard.templateCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = IMPORT_TEMPLATE_FILE;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="src">
    <p class="src-intro">
      Copy the rows from Excel, header row included, and paste them here, or drop a CSV file. Up to
      {{ IMPORT_MAX_ROWS }} rows. The
      <button type="button" class="src-link" @click="downloadTemplate">CSV template</button>
      has headers that map with no changes.
    </p>

    <div class="src-grid">
      <div class="src-field">
        <label class="fld-label" for="src-paste">Paste rows</label>
        <Textarea
          id="src-paste"
          v-model="text"
          rows="8"
          class="mono"
          placeholder="First name&#9;Last name&#9;Department…"
          spellcheck="false"
          fluid
          @paste="onClipboard"
        />
        <Button
          label="Use these rows"
          icon="pi pi-check"
          size="small"
          :disabled="!text.trim()"
          class="src-use"
          @click="onPaste"
        />
      </div>
      <div
        class="src-drop"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <i class="pi pi-file" aria-hidden="true" />
        <span>Drop a CSV file here</span>
        <Button
          label="Choose a file"
          size="small"
          severity="secondary"
          outlined
          @click="picker?.click()"
        />
        <input
          ref="picker"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          class="sr-only"
          aria-label="CSV file"
          @change="onPick"
        />
        <span class="hint">CSV only: save a workbook as CSV first.</span>
      </div>
    </div>

    <Message v-if="sourceError" severity="error" :closable="false" class="src-msg">
      {{ sourceError }}
    </Message>

    <template v-if="table">
      <p class="src-summary">
        <i class="pi pi-table" aria-hidden="true" />
        {{ draft.fileName ?? 'Pasted rows' }}: {{ table.rows.length }}
        {{ table.rows.length === 1 ? 'row' : 'rows' }} and {{ table.header.length }} columns,
        separated by {{ DELIMITER_NAME[table.delimiter] }}.
      </p>
      <Message
        v-for="p in sourceProblems"
        :key="p"
        severity="error"
        :closable="false"
        class="src-msg"
      >
        {{ p }}
      </Message>
      <Message v-if="headerMissing" severity="warn" :closable="false" class="src-msg">
        None of the first row’s cells name a column OpenADUC knows. The first row has to be the
        header row; if it is, choose each column in the next step.
      </Message>
    </template>
  </div>
</template>

<style scoped>
.src-intro {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-2);
}

.src-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-text);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.src-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
}

@media (max-width: 767.98px) {
  .src-grid {
    grid-template-columns: 1fr;
  }
}

.src-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.src-use {
  align-self: flex-start;
}

.src-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-2);
  text-align: center;
}

.src-drop.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.src-drop .pi-file {
  font-size: 20px;
  color: var(--text-3);
}

.src-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0 8px;
  font-size: 13px;
  color: var(--text);
}

.src-msg {
  margin: 8px 0 0;
}

.mono {
  font-family: var(--font-mono);
}
</style>
