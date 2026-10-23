<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Rename a person: name parts, display name, the directory name (cn), both
  logon names and the primary email in one change. Suggestion behaviour
  lives in useUserRename.
-->
<script setup lang="ts">
import { watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import type { RenameField, UserDetail } from '@openaduc/shared';
import { useUserRename } from '../composables/useUserRename.js';

const props = defineProps<{
  visible: boolean;
  user: UserDetail | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  renamed: [];
}>();

const FIELDS: { key: RenameField; label: string; hint?: string; mono?: boolean; max: number }[] = [
  { key: 'displayName', label: 'Display name', max: 256 },
  {
    key: 'cn',
    label: 'Full name',
    hint: 'The object’s name in the directory tree (cn).',
    max: 64,
  },
  { key: 'userPrincipalName', label: 'User logon name (UPN)', mono: true, max: 256 },
  { key: 'samAccountName', label: 'Pre-Windows 2000 logon name', mono: true, max: 20 },
  { key: 'email', label: 'Email', mono: true, max: 256 },
];

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
    emit('renamed');
    emit('update:visible', false);
  },
});

watch(
  () => props.visible,
  (open) => {
    if (open) reset(props.user);
  },
  { immediate: true },
);

function close(): void {
  if (!submitting.value) emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Rename user"
    :style="{ width: '36rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && close()"
  >
    <p class="ru-intro">
      Enter the new name. The other fields follow this account’s current naming pattern, and you can
      edit any of them.
    </p>

    <div class="ru-names">
      <div class="ru-field">
        <label class="fld-label" for="ru-given">First name</label>
        <InputText
          id="ru-given"
          :model-value="form.givenName"
          maxlength="64"
          fluid
          :disabled="submitting"
          @update:model-value="(v) => setName('givenName', v)"
        />
      </div>
      <div class="ru-field">
        <label class="fld-label" for="ru-surname">Last name</label>
        <InputText
          id="ru-surname"
          :model-value="form.surname"
          maxlength="64"
          fluid
          :disabled="submitting"
          @update:model-value="(v) => setName('surname', v)"
        />
      </div>
    </div>

    <div v-for="f in FIELDS" :key="f.key" class="ru-field">
      <label class="fld-label" :for="`ru-${f.key}`">{{ f.label }}</label>
      <InputText
        :id="`ru-${f.key}`"
        :model-value="form[f.key]"
        :class="{ mono: f.mono }"
        :maxlength="f.max"
        spellcheck="false"
        fluid
        :disabled="submitting"
        @update:model-value="(v) => setField(f.key, v)"
      />
      <span v-if="unresolved.has(f.key)" class="ru-note ru-note-warn">
        Couldn’t tell how this was built from the old name. Check it.
      </span>
      <span v-else-if="changed(f.key)" class="ru-note">
        Was <span :class="{ mono: f.mono }">{{ original[f.key] ?? '(empty)' }}</span>
      </span>
      <span v-else-if="f.hint" class="ru-note">{{ f.hint }}</span>
    </div>

    <label v-if="offerKeepAlias" class="ru-check">
      <input v-model="keepOldEmailAsAlias" type="checkbox" :disabled="submitting" />
      <span>
        Keep <span class="mono">{{ original.email }}</span> as an alias so mail sent to it still
        arrives
      </span>
    </label>

    <Message v-if="logonChanging" severity="warn" :closable="false" class="ru-msg">
      The person signs in with the new logon name from now on. Services synced from AD, such as
      Microsoft 365, pick it up at their next sync.
    </Message>
    <Message v-if="error" severity="error" :closable="false" class="ru-msg">{{ error }}</Message>

    <template #footer>
      <Button label="Cancel" text severity="secondary" :disabled="submitting" @click="close" />
      <Button
        label="Rename"
        icon="pi pi-id-card"
        :loading="submitting"
        :disabled="changedKeys.length === 0"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.ru-intro {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-3);
}

.ru-names {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.ru-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.ru-note {
  font-size: 11.5px;
  color: var(--text-3);
}

.ru-note-warn {
  color: var(--amber);
}

.ru-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0 12px;
  font-size: 13px;
  color: var(--text-2);
}

.ru-check input {
  margin-top: 3px;
}

.ru-msg {
  margin: 8px 0 0;
}

.mono {
  font-family: var(--font-mono);
}
</style>
