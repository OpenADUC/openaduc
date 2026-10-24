<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Edit the selected users' attributes: leave each field unchanged, set it
  or clear it, then see user by user what it would change, then confirm.
  Renders a useBulkAttributeEdit the page owns; confirming starts the
  bulk job.
-->
<script setup lang="ts">
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import SelectButton from 'primevue/selectbutton';
import Textarea from 'primevue/textarea';
import type { BulkAttributeField } from '@openaduc/shared';
import type { FieldMode, useBulkAttributeEdit } from '../composables/useBulkAttributeEdit.js';
import { MULTIPLE_VALUES } from '../composables/useBulkAttributeEdit.js';
import { ATTRIBUTE_LABELS, countryOptions, shownValue } from '../lib/bulkAttributes.js';

const props = defineProps<{
  workflow: ReturnType<typeof useBulkAttributeEdit>;
  /** Selected users the list's filters hide. */
  hiddenCount: number;
}>();

const {
  visible,
  title,
  confirmLabel,
  loading,
  loadError,
  modes,
  values,
  manager,
  managerQuery,
  managerResults,
  managerSearching,
  managerSearchError,
  problems,
  canPreview,
  preview,
  previewing,
  previewError,
  canConfirm,
} = props.workflow;
const w = props.workflow;

const SECTIONS: { title: string; fields: BulkAttributeField[] }[] = [
  {
    title: 'Organization',
    fields: [
      'title',
      'department',
      'company',
      'physicalDeliveryOfficeName',
      'manager',
      'description',
    ],
  },
  {
    title: 'Address',
    fields: ['streetAddress', 'postOfficeBox', 'l', 'st', 'postalCode', 'country'],
  },
];
const MULTILINE = new Set<BulkAttributeField>(['streetAddress', 'description']);

const modeOptions: { label: string; value: FieldMode }[] = [
  { label: 'Unchanged', value: 'keep' },
  { label: 'Set', value: 'set' },
  { label: 'Clear', value: 'clear' },
];
const countries = countryOptions();

/** What the field holds now, beside its controls. */
function now(field: BulkAttributeField): string {
  const value = w.shown(field);
  if (value === MULTIPLE_VALUES) return MULTIPLE_VALUES;
  return value === null ? 'empty' : value;
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    :style="{ width: '42rem' }"
    @update:visible="(v) => !v && w.close()"
  >
    <template v-if="!preview">
      <p v-if="loading" class="be-note">Reading their current values…</p>
      <Message v-else-if="loadError" severity="warn" :closable="false" class="be-message">
        Couldn’t read their current values: {{ loadError }}
      </Message>
      <section v-for="section in SECTIONS" :key="section.title" class="be-section">
        <h3 class="be-section-title">{{ section.title }}</h3>
        <div v-for="field in section.fields" :key="field" class="be-field">
          <div class="be-field-head">
            <span :id="`be-${field}-label`" class="be-label">{{ ATTRIBUTE_LABELS[field] }}</span>
            <SelectButton
              :model-value="modes[field]"
              :options="modeOptions"
              option-label="label"
              option-value="value"
              :allow-empty="false"
              size="small"
              :aria-labelledby="`be-${field}-label`"
              @update:model-value="(m: FieldMode) => w.setMode(field, m)"
            />
          </div>
          <p
            v-if="!loading && !loadError"
            class="be-now"
            :class="{ 'be-now-multiple': w.shown(field) === MULTIPLE_VALUES }"
          >
            Now: {{ now(field) }}
          </p>
          <template v-if="modes[field] === 'set'">
            <div v-if="field === 'manager'" class="be-manager">
              <p v-if="manager" class="be-chosen"><i class="pi pi-user" /> {{ manager.name }}</p>
              <InputText
                v-model="managerQuery"
                placeholder="Search users…"
                aria-label="Search for the manager"
                fluid
              />
              <p v-if="managerSearching" class="be-note">Searching…</p>
              <p v-else-if="managerSearchError" class="be-problem">
                Couldn’t search users: {{ managerSearchError }}
              </p>
              <ul v-else-if="managerResults.length > 0" class="be-results">
                <li v-for="u in managerResults" :key="u.id">
                  <button type="button" class="be-result" @click="w.chooseManager(u)">
                    <span>{{ u.displayName ?? u.samAccountName }}</span>
                    <span class="be-result-sam mono">{{ u.samAccountName }}</span>
                  </button>
                </li>
              </ul>
            </div>
            <Select
              v-else-if="field === 'country'"
              :model-value="values.country || null"
              :options="countries"
              option-label="label"
              option-value="value"
              filter
              placeholder="Choose a country"
              :aria-labelledby="`be-${field}-label`"
              fluid
              @update:model-value="(c: string | null) => w.setValue('country', c ?? '')"
            />
            <Textarea
              v-else-if="MULTILINE.has(field)"
              :model-value="values[field]"
              rows="2"
              auto-resize
              :aria-labelledby="`be-${field}-label`"
              :invalid="!!problems[field]"
              fluid
              @update:model-value="(v: string) => w.setValue(field, v)"
            />
            <InputText
              v-else
              :model-value="values[field]"
              :aria-labelledby="`be-${field}-label`"
              :invalid="!!problems[field]"
              fluid
              @update:model-value="(v: string | undefined) => w.setValue(field, v ?? '')"
            />
            <p v-if="problems[field]" class="be-problem">{{ problems[field] }}</p>
          </template>
        </div>
      </section>
      <Message v-if="previewError" severity="error" :closable="false" class="be-message">
        Couldn’t work out what it would change: {{ previewError }}
      </Message>
    </template>

    <template v-else>
      <p v-if="hiddenCount > 0" class="be-note">
        {{
          hiddenCount === 1
            ? '1 of them is hidden by the current filters.'
            : `${hiddenCount} of them are hidden by the current filters.`
        }}
      </p>
      <p v-if="preview.unknownCount > 0" class="be-note">
        {{
          preview.unknownCount === 1
            ? '1 selected account isn’t in the directory any more; it will fail.'
            : `${preview.unknownCount} selected accounts aren’t in the directory any more; they will fail.`
        }}
      </p>
      <ul class="be-counts" aria-label="Changes by field">
        <li v-for="f in preview.fields" :key="f.field">
          <strong>{{ ATTRIBUTE_LABELS[f.field] }}</strong
          >: {{ f.count === 1 ? '1 user changes' : `${f.count} users change` }}
        </li>
      </ul>
      <Message v-if="preview.changed.count === 0" severity="info" :closable="false">
        They’re all as asked already. There’s nothing to change.
      </Message>
      <ul v-else class="be-users" aria-label="Changes by user">
        <li v-for="u in preview.changed.users" :key="u.id" class="be-user">
          <span class="be-user-name">{{ u.name }}</span>
          <ul class="be-user-changes">
            <li v-for="c in u.changes" :key="c.field">
              <span class="be-change-field">{{ ATTRIBUTE_LABELS[c.field] }}</span>
              <span class="be-before">{{ shownValue(c.before) }}</span>
              <i class="pi pi-arrow-right be-arrow" aria-label="becomes" />
              <span class="be-after">{{ shownValue(c.after) }}</span>
            </li>
          </ul>
        </li>
      </ul>
      <p v-if="preview.changed.count > preview.changed.users.length" class="be-note">
        The first {{ preview.changed.users.length }} are listed;
        {{ preview.changed.count - preview.changed.users.length }} more aren’t.
      </p>
      <details v-if="preview.unchanged.count > 0" class="be-unchanged">
        <summary>Already as asked, unchanged ({{ preview.unchanged.count }})</summary>
        <ul>
          <li v-for="u in preview.unchanged.users" :key="u.id">{{ u.name }}</li>
        </ul>
        <p v-if="preview.unchanged.count > preview.unchanged.users.length" class="be-note">
          The first {{ preview.unchanged.users.length }} are listed;
          {{ preview.unchanged.count - preview.unchanged.users.length }} more aren’t.
        </p>
      </details>
    </template>

    <template #footer>
      <template v-if="preview">
        <Button label="Back" severity="secondary" text @click="w.back" />
        <Button
          :label="confirmLabel"
          icon="pi pi-pencil"
          :disabled="!canConfirm"
          @click="w.confirm"
        />
      </template>
      <template v-else>
        <Button label="Cancel" severity="secondary" text @click="w.close" />
        <Button
          label="Preview"
          icon="pi pi-eye"
          :loading="previewing"
          :disabled="!canPreview"
          @click="w.review"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.be-section {
  margin-bottom: 14px;
}

.be-section-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.be-field {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.be-field:last-child {
  border-bottom: 0;
}

.be-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.be-label {
  font-size: 13px;
  font-weight: 500;
}

.be-now {
  margin: 2px 0 6px;
  font-size: 12px;
  color: var(--text-3);
}

.be-now-multiple {
  font-style: italic;
}

.be-manager {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.be-chosen {
  margin: 0;
  font-size: 13px;
}

.be-results {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 10rem;
  overflow-y: auto;
}

.be-result {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.be-result:hover {
  background: var(--surface-2);
}

.be-result-sam {
  font-size: 11.5px;
  color: var(--text-3);
}

.be-problem {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--red);
}

.be-note {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.be-message {
  margin: 8px 0;
}

.be-counts {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: 13px;
}

.be-users {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 22rem;
  overflow-y: auto;
}

.be-user {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.be-user:last-child {
  border-bottom: 0;
}

.be-user-name {
  font-size: 13px;
  font-weight: 600;
}

.be-user-changes {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: 12.5px;
}

.be-user-changes li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.be-change-field {
  min-width: 7rem;
  color: var(--text-2);
}

.be-before {
  color: var(--text-3);
  text-decoration: line-through;
  white-space: pre-line;
}

.be-arrow {
  font-size: 10px;
  color: var(--text-3);
}

.be-after {
  white-space: pre-line;
}

.be-unchanged {
  margin-top: 10px;
  font-size: 12.5px;
}

.be-unchanged summary {
  cursor: pointer;
  color: var(--text-2);
}

.be-unchanged ul {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 10rem;
  overflow-y: auto;
}
</style>
