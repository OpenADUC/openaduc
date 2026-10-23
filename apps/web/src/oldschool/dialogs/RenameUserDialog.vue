<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Rename User" dialog: full name, first/last, display name and
     both logon names, plus the email the modern dialog also covers. Same
     form logic as the modern dialog (useRenameForm), so typing a new name
     fills the rest in by the account's existing pattern. -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import WinDialog from './WinDialog.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import { useRenameForm } from '../../design/composables/useRenameForm.js';
import type { RenameField } from '@openaduc/shared';

const props = defineProps<{ windowId: number; id: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const auth = useAuthStore();
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
  buildRequest,
} = useRenameForm();

const loading = ref(true);
const err = ref<string | null>(null);

const FIELDS: { key: RenameField; label: string; max: number }[] = [
  { key: 'cn', label: 'Full name:', max: 64 },
  { key: 'displayName', label: 'Display name:', max: 256 },
  { key: 'userPrincipalName', label: 'User logon name:', max: 256 },
  { key: 'samAccountName', label: 'Pre-Windows 2000:', max: 20 },
  { key: 'email', label: 'E-mail:', max: 256 },
];

onMounted(async () => {
  try {
    const { user } = await api.users.get(props.id);
    reset(user);
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally {
    loading.value = false;
  }
});

function onInput(key: RenameField | 'givenName' | 'surname', ev: Event): void {
  const value = (ev.target as HTMLInputElement).value;
  if (key === 'givenName' || key === 'surname') setName(key, value);
  else setField(key, value);
}

function submit(): void {
  if (changedKeys.value.length === 0) return;
  err.value = null;
  auth.requireStepUp(async () => {
    try {
      await api.users.rename(props.id, buildRequest());
      toast.add({
        severity: 'success',
        summary: 'User renamed.',
        detail: `${original.value.samAccountName ?? 'The user'} has been renamed.`,
        life: 4000,
      });
      store.bumpData();
      emit('close');
    } catch (e) {
      err.value = e instanceof ApiError ? e.message : (e as Error).message;
    }
  }, 'Renaming a user requires step-up authentication.');
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="Rename User"
    icon="user"
    hide-apply
    :can-ok="!loading && changedKeys.length > 0"
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
            maxlength="64"
            :value="form.givenName ?? ''"
            @input="onInput('givenName', $event)"
          />
          <label class="label" for="rn-sn">Last name:</label>
          <input
            id="rn-sn"
            class="os-input"
            maxlength="64"
            :value="form.surname ?? ''"
            @input="onInput('surname', $event)"
          />
          <template v-for="f in FIELDS" :key="f.key">
            <label class="label" :for="`rn-${f.key}`">{{ f.label }}</label>
            <input
              :id="`rn-${f.key}`"
              class="os-input"
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
          <input v-model="keepOldEmailAsAlias" type="checkbox" /> Keep {{ original.email }} as an
          e-mail alias
        </label>

        <div v-if="err" class="os-error" style="margin-top: 12px">{{ err }}</div>
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
