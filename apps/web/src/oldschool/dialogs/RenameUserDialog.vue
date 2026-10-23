<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Rename User" dialog: full name, first/last, display name and
     both logon names, plus the email the modern dialog also covers. Same
     workflow as the modern dialog (useUserRename), so typing a new name
     fills the rest in by the account's existing pattern. -->
<script setup lang="ts">
import WinDialog from './WinDialog.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import { useUserRecord } from '../../design/composables/useDirectoryRecords.js';
import { useUserRename } from '../../design/composables/useUserRename.js';
import type { RenameField } from '@openaduc/shared';

const props = defineProps<{ windowId: number; id: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const {
  original,
  form,
  unresolved,
  keepOldEmailAsAlias,
  reset,
  setName,
  setField,
  changed,
  changedKeys,
  logonChanging,
  offerKeepAlias,
  submitting,
  error,
  submit,
} = useUserRename({
  onRenamed: () => {
    toast.add({
      severity: 'success',
      summary: 'User renamed.',
      detail: `${original.value.samAccountName ?? 'The user'} has been renamed.`,
      life: 4000,
    });
    store.bumpData();
    emit('close');
  },
});
const { loading, error: loadError, load } = useUserRecord({ id: () => props.id, onLoaded: reset });
void load();

const FIELDS: { key: RenameField; label: string; max: number }[] = [
  { key: 'cn', label: 'Full name:', max: 64 },
  { key: 'displayName', label: 'Display name:', max: 256 },
  { key: 'userPrincipalName', label: 'User logon name:', max: 256 },
  { key: 'samAccountName', label: 'Pre-Windows 2000:', max: 20 },
  { key: 'email', label: 'E-mail:', max: 256 },
];

function onInput(key: RenameField | 'givenName' | 'surname', ev: Event): void {
  const value = (ev.target as HTMLInputElement).value;
  if (key === 'givenName' || key === 'surname') setName(key, value);
  else setField(key, value);
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="Rename User"
    icon="user"
    hide-apply
    :can-ok="!loading && changedKeys.length > 0 && !submitting"
    @ok="submit"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div style="padding: 16px 18px; font-size: 12px">
      <div v-if="loading">Loading…</div>
      <template v-else>
        <div class="os-form" style="grid-template-columns: 130px minmax(0, 1fr); row-gap: 7px">
          <label class="label" for="rn-given">First name:</label>
          <input
            id="rn-given"
            class="os-input"
            :disabled="submitting"
            maxlength="64"
            :value="form.givenName ?? ''"
            @input="onInput('givenName', $event)"
          />
          <label class="label" for="rn-sn">Last name:</label>
          <input
            id="rn-sn"
            class="os-input"
            :disabled="submitting"
            maxlength="64"
            :value="form.surname ?? ''"
            @input="onInput('surname', $event)"
          />
          <template v-for="f in FIELDS" :key="f.key">
            <label class="label" :for="`rn-${f.key}`">{{ f.label }}</label>
            <input
              :id="`rn-${f.key}`"
              class="os-input"
              :disabled="submitting"
              :class="{ 'rn-unresolved': unresolved.has(f.key) }"
              :maxlength="f.max"
              spellcheck="false"
              :value="form[f.key] ?? ''"
              :title="
                unresolved.has(f.key)
                  ? 'Couldn’t tell how this was built from the old name. Check it.'
                  : changed(f.key)
                    ? `Was: ${original[f.key] ?? '(empty)'}`
                    : undefined
              "
              @input="onInput(f.key, $event)"
            />
          </template>
        </div>

        <label v-if="offerKeepAlias" class="os-check" style="margin-top: 10px">
          <input v-model="keepOldEmailAsAlias" type="checkbox" :disabled="submitting" /> Keep
          {{ original.email }} as an e-mail alias
        </label>

        <div v-if="loadError || error" class="os-error" style="margin-top: 12px">
          {{ loadError ?? error }}
        </div>
        <div v-else-if="unresolved.size > 0" class="os-info" style="margin-top: 12px">
          Highlighted fields didn’t follow a pattern from the old name and were left as they were.
        </div>
        <div v-else-if="logonChanging" class="os-info" style="margin-top: 12px">
          The user signs in with the new logon name from now on.
        </div>
      </template>
    </div>
  </WinDialog>
</template>

<style scoped>
.rn-unresolved {
  background: #fff8db;
}
</style>
