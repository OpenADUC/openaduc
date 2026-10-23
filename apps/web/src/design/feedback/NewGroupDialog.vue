<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Create a group in an OU. The form, the name checks and the create live in
  useGroupCreation; this renders them. Opened from the group list, or from
  an OU with that OU preselected.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import SelectButton from 'primevue/selectbutton';
import TreeSelect from 'primevue/treeselect';
import { GROUP_SCOPES, GROUP_TYPES, type GroupCreateResponse } from '@openaduc/shared';
import { SCOPE_LABEL, TYPE_LABEL, useGroupCreation } from '../composables/useGroupCreation.js';
import { useOuTree } from '../composables/useOuTree.js';
import { ouTreeNodes } from '../lib/ouTree.js';

const props = defineProps<{
  visible: boolean;
  /** The OU to create the group in, when the operator started from one. */
  parentDn?: string | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  created: [created: GroupCreateResponse];
}>();

const {
  form,
  reset,
  setName,
  setSamAccountName,
  problems,
  checking,
  checkError,
  taken,
  canSubmit,
  submitting,
  error,
  submit,
} = useGroupCreation({ onCreated: (created) => emit('created', created) });

const { ous, loading: ousLoading, error: ousError, load: loadOus } = useOuTree();
const ouTree = computed(() => ouTreeNodes(ous.value));

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    reset(props.parentDn ?? null);
    void loadOus();
  },
  { immediate: true },
);

// PrimeVue TreeSelect keys its single selection by node key, which is the DN.
const parentSelection = computed<Record<string, boolean>>({
  get: () => (form.parentDn ? { [form.parentDn]: true } : {}),
  set: (keys) => (form.parentDn = Object.keys(keys).find((k) => keys[k]) ?? null),
});

const scopeOptions = GROUP_SCOPES.map((value) => ({ value, label: SCOPE_LABEL[value] }));
const typeOptions = GROUP_TYPES.map((value) => ({ value, label: TYPE_LABEL[value] }));

function close(): void {
  if (!submitting.value) emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="New group"
    :style="{ width: '34rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && close()"
  >
    <div class="ng-field">
      <label class="fld-label" for="ng-parent">Create in</label>
      <Message v-if="ousError" severity="error" :closable="false">{{ ousError }}</Message>
      <TreeSelect
        v-else
        v-model="parentSelection"
        input-id="ng-parent"
        :options="ouTree"
        :loading="ousLoading"
        selection-mode="single"
        placeholder="Pick an OU"
        fluid
        :disabled="submitting"
      />
    </div>

    <div class="ng-field">
      <label class="fld-label" for="ng-name">Group name</label>
      <InputText
        id="ng-name"
        :model-value="form.name"
        maxlength="64"
        autofocus
        fluid
        :invalid="!!problems.name || !!taken.name"
        :disabled="submitting"
        @update:model-value="setName"
      />
      <span v-if="problems.name" class="ng-note ng-note-bad">{{ problems.name }}</span>
      <span v-else-if="taken.name" class="ng-note ng-note-bad">
        {{ taken.name }}
      </span>
    </div>

    <div class="ng-field">
      <label class="fld-label" for="ng-sam">Group name (pre-Windows 2000)</label>
      <InputText
        id="ng-sam"
        class="mono"
        :model-value="form.samAccountName"
        maxlength="256"
        spellcheck="false"
        fluid
        :invalid="!!problems.samAccountName || !!taken.samAccountName"
        :disabled="submitting"
        @update:model-value="setSamAccountName"
      />
      <span v-if="problems.samAccountName" class="ng-note ng-note-bad">
        {{ problems.samAccountName }}
      </span>
      <span v-else-if="taken.samAccountName" class="ng-note ng-note-bad">
        {{ taken.samAccountName }}
      </span>
      <span v-else class="ng-note">Must be unique across the domain, users included.</span>
    </div>

    <div class="ng-field">
      <label class="fld-label" for="ng-description">Description (optional)</label>
      <InputText
        id="ng-description"
        v-model="form.description"
        maxlength="1024"
        fluid
        :disabled="submitting"
      />
    </div>

    <div class="ng-choices">
      <div class="ng-field">
        <span class="fld-label">Group scope</span>
        <SelectButton
          v-model="form.scope"
          :options="scopeOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="Group scope"
          :disabled="submitting"
        />
      </div>
      <div class="ng-field">
        <span class="fld-label">Group type</span>
        <SelectButton
          v-model="form.type"
          :options="typeOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="Group type"
          :disabled="submitting"
        />
      </div>
    </div>

    <p v-if="checkError" class="ng-note">
      Couldn’t check the names ({{ checkError }}). They’re checked again when you create the group.
    </p>
    <Message v-if="error" severity="error" :closable="false" class="ng-msg">{{ error }}</Message>

    <template #footer>
      <span v-if="checking" class="ng-note ng-checking">Checking names…</span>
      <Button label="Cancel" text severity="secondary" :disabled="submitting" @click="close" />
      <Button
        label="Create group"
        icon="pi pi-plus"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.ng-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.ng-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
}

.ng-note {
  font-size: 11.5px;
  color: var(--text-3);
}

.ng-note-bad {
  color: var(--red);
}

.ng-checking {
  margin-right: auto;
}

.ng-msg {
  margin: 8px 0 0;
}

.mono {
  font-family: var(--font-mono);
}
</style>
