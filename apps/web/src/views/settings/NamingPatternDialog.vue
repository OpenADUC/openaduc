<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onMounted } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import type { NamingSettings } from '@openaduc/shared';
import { useNamingPattern } from '../../design/composables/useNamingPattern.js';

const props = defineProps<{ directoryId: number }>();
const visible = defineModel<boolean>('visible', { required: true });
const emit = defineEmits<{ saved: [naming: NamingSettings] }>();

const naming = useNamingPattern(props.directoryId, {
  onSaved: (saved) => {
    emit('saved', saved);
    visible.value = false;
  },
});

const TOKENS: [string, string][] = [
  ['{first}', 'first name'],
  ['{last}', 'last name'],
  ['{f}', 'first initial'],
  ['{l}', 'last initial'],
  ['{mi}', 'middle initial'],
];

onMounted(naming.load);
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :closable="!naming.saving.value"
    header="Naming pattern"
    :style="{ width: 'min(760px, 95vw)' }"
  >
    <form class="form-stack" @submit.prevent="naming.save">
      <p class="hint">
        How a new account’s username is built from the person’s legal name. A preferred first name
        only changes the display name. Existing accounts keep their names.
      </p>
      <div class="form-grid-2">
        <div class="form-row">
          <label for="naming-pattern" class="fld-label">Pattern</label>
          <InputText
            id="naming-pattern"
            v-model="naming.form.pattern"
            class="w-full mono"
            :invalid="!!naming.problem.value"
            :disabled="naming.loading.value"
            aria-describedby="naming-pattern-help"
            spellcheck="false"
            autocomplete="off"
          />
          <small v-if="naming.problem.value" class="field-error">{{ naming.problem.value }}</small>
          <small id="naming-pattern-help" class="hint">
            <template v-for="([token, meaning], i) in TOKENS" :key="token"
              ><span class="mono">{{ token }}</span> {{ meaning
              }}{{ i < TOKENS.length - 1 ? ', ' : '' }}</template
            >. Put dots, hyphens or underscores between them.
          </small>
        </div>
        <div class="form-row">
          <label for="naming-upn-suffix" class="fld-label">UPN suffix</label>
          <Select
            v-model="naming.form.upnSuffix"
            input-id="naming-upn-suffix"
            :options="naming.upnSuffixes.value"
            :disabled="naming.loading.value"
            class="w-full"
          />
          <small class="hint"
            >The UPN and email are <span class="mono">username@suffix</span>.</small
          >
        </div>
      </div>

      <section v-if="naming.preview.value.length" aria-labelledby="naming-preview-title">
        <h4 id="naming-preview-title" class="section-title">Preview</h4>
        <table class="preview">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">sAMAccountName</th>
              <th scope="col">UPN and email</th>
              <th scope="col">Display name</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in naming.preview.value" :key="row.name.first + row.name.last">
              <tr>
                <td>
                  {{ row.name.first }}
                  <template v-if="row.name.middleInitial">{{ row.name.middleInitial }}.</template>
                  {{ row.name.last }}
                  <span v-if="row.name.preferredFirst" class="hint"
                    >(goes by {{ row.name.preferredFirst }})</span
                  >
                </td>
                <td class="mono sam">{{ row.suggestion.samAccountName }}</td>
                <td class="mono">{{ row.suggestion.upn }}</td>
                <td>{{ row.suggestion.displayName }}</td>
              </tr>
              <tr v-if="row.suggestion.deviations.length" class="notes">
                <td colspan="4">
                  <ul>
                    <li
                      v-for="(d, i) in row.suggestion.deviations"
                      :key="i"
                      :class="{ attention: d.approval !== 'none' }"
                    >
                      {{ d.reason }}
                    </li>
                  </ul>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>

      <Message v-if="naming.error.value" severity="error" :closable="false">{{
        naming.error.value
      }}</Message>
    </form>
    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        :disabled="naming.saving.value"
        @click="visible = false"
      />
      <Button
        label="Save pattern"
        :loading="naming.saving.value"
        :disabled="!naming.changed.value || !!naming.problem.value"
        @click="naming.save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-grid-2 {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 12px;
}
@media (max-width: 760px) {
  .form-grid-2 {
    grid-template-columns: 1fr;
  }
}
.hint {
  margin: 0;
}
.field-error {
  color: var(--red);
}
.section-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.preview {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.preview th {
  text-align: left;
  font-weight: 500;
  color: var(--text-3);
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--border);
}
.preview td {
  padding: 6px 8px 6px 0;
  vertical-align: top;
  color: var(--text);
  overflow-wrap: anywhere;
}
.preview td.sam {
  white-space: nowrap;
}
.preview tr:not(.notes) td {
  border-top: 1px solid var(--border);
}
.preview .notes td {
  padding-top: 0;
}
.notes ul {
  margin: 0;
  padding-left: 16px;
  color: var(--text-3);
  font-size: 12px;
}
.notes li.attention {
  color: var(--amber);
}
.w-full {
  width: 100%;
}
</style>
