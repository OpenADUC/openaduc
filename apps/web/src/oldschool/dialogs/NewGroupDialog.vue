<!-- SPDX-License-Identifier: BUSL-1.1
     "New Object - Group", rendering the shared create workflow
     (useGroupCreation): the pre-Windows 2000 name follows the group name,
     and a name already taken shows before OK is pressed. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useToast } from 'primevue/usetoast';
import { GROUP_SCOPES, GROUP_TYPES } from '@openaduc/shared';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import {
  SCOPE_LABEL,
  TYPE_LABEL,
  useGroupCreation,
} from '../../design/composables/useGroupCreation.js';

const props = defineProps<{ windowId: number; parentDn: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const {
  form,
  reset,
  setName,
  setSamAccountName,
  problems,
  taken,
  canSubmit,
  submitting,
  error,
  submit,
} = useGroupCreation({
  onCreated: (group) => {
    toast.add({
      severity: 'success',
      summary: 'Object created.',
      detail: `${group.name ?? group.samAccountName} has been created.`,
      life: 4000,
    });
    store.bumpData();
    emit('close');
  },
});
reset(props.parentDn);

/** "OU=Groups,OU=Corp,DC=corp,DC=example" → "corp.example/Corp/Groups", as ADUC shows it. */
const createIn = computed(() => {
  const parts = props.parentDn.split(/(?<!\\),/).map((p) => p.trim());
  const domain = parts.filter((p) => /^DC=/i.test(p)).map((p) => p.slice(3));
  const path = parts
    .filter((p) => !/^DC=/i.test(p))
    .map((p) => p.slice(p.indexOf('=') + 1).replace(/\\(.)/g, '$1'))
    .reverse();
  return [domain.join('.'), ...path].join('/');
});

const problem = computed(
  () =>
    problems.value.name ??
    (taken.value.name
      ? `The name is already used in this container by ${taken.value.name}.`
      : null) ??
    problems.value.samAccountName ??
    (taken.value.samAccountName
      ? `The pre-Windows 2000 name is already used by ${taken.value.samAccountName}.`
      : null) ??
    error.value,
);
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="New Object - Group"
    icon="newgroup"
    hide-apply
    :resizable="false"
    :can-ok="canSubmit"
    @ok="submit"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div class="os-tab-body">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
        <WinIcon name="group" :size="32" />
        <span>Create in: {{ createIn }}</span>
      </div>
      <hr style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 0 0 12px" />
      <label for="os-ng-name" style="display: block; margin-bottom: 4px">Group name:</label>
      <input
        id="os-ng-name"
        class="os-input"
        :value="form.name"
        maxlength="64"
        :disabled="submitting"
        @input="setName(($event.target as HTMLInputElement).value)"
      />
      <label for="os-ng-sam" style="display: block; margin: 10px 0 4px"
        >Group name (pre-Windows 2000):</label
      >
      <input
        id="os-ng-sam"
        class="os-input"
        :value="form.samAccountName"
        maxlength="256"
        spellcheck="false"
        :disabled="submitting"
        @input="setSamAccountName(($event.target as HTMLInputElement).value)"
      />
      <div style="display: flex; gap: 12px; margin-top: 10px">
        <fieldset class="os-groupbox" style="flex: 1">
          <legend>Group scope</legend>
          <label v-for="s in GROUP_SCOPES" :key="s" class="os-check" style="display: flex">
            <input v-model="form.scope" type="radio" :value="s" :disabled="submitting" />
            {{ SCOPE_LABEL[s] }}
          </label>
        </fieldset>
        <fieldset class="os-groupbox" style="flex: 1">
          <legend>Group type</legend>
          <label v-for="t in GROUP_TYPES" :key="t" class="os-check" style="display: flex">
            <input v-model="form.type" type="radio" :value="t" :disabled="submitting" />
            {{ TYPE_LABEL[t] }}
          </label>
        </fieldset>
      </div>
      <div v-if="problem" class="os-error" style="margin-top: 8px">{{ problem }}</div>
    </div>
  </WinDialog>
</template>
