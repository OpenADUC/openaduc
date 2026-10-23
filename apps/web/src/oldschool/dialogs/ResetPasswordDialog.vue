<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import WinDialog from './WinDialog.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import { usePasswordReset } from '../../design/composables/usePasswordReset.js';

const props = defineProps<{ windowId: number; id: string; samAccountName: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const {
  loading,
  password,
  shown,
  copied,
  forceChangeAtNextLogin,
  alsoUnlock,
  offerUnlock,
  checks,
  acceptable,
  historyNote,
  error,
  load,
  generate,
  copy,
  submit,
} = usePasswordReset({
  onReset: ({ unlocked }) => {
    toast.add({
      severity: 'success',
      summary: 'Password has been changed.',
      detail: `The password for ${props.samAccountName} has been changed${unlocked ? ' and the account unlocked' : ''}.`,
      life: 4000,
    });
    store.bumpData();
    emit('close');
  },
});

// A typo guard for a password the operator can't see.
const confirmPwd = ref('');
const confirmed = computed(() => shown.value || confirmPwd.value === password.value);

onMounted(() => load(props.id));
</script>

<template>
  <WinDialog
    :window-id="windowId"
    :title="`Reset Password`"
    icon="properties"
    hide-apply
    ok-label="OK"
    :can-ok="!loading && acceptable && confirmed"
    @ok="submit"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div style="padding: 18px 18px 14px 18px; font-size: 12px">
      <div style="margin-bottom: 14px">
        New password for: <strong>{{ samAccountName }}</strong>
      </div>

      <div class="os-form" style="grid-template-columns: 130px minmax(0, 1fr); row-gap: 8px">
        <label class="label" for="np">New password:</label>
        <input
          id="np"
          :type="shown ? 'text' : 'password'"
          class="os-input"
          v-model="password"
          autocomplete="new-password"
          spellcheck="false"
        />
        <template v-if="!shown">
          <label class="label" for="cp">Confirm password:</label>
          <input
            id="cp"
            type="password"
            class="os-input"
            v-model="confirmPwd"
            autocomplete="new-password"
          />
        </template>
      </div>

      <div style="margin-top: 8px; display: flex; gap: 6px; align-items: center">
        <button type="button" class="os-btn" @click="generate">Generate</button>
        <button type="button" class="os-btn" :disabled="!password" @click="copy">Copy</button>
        <label class="os-check"><input type="checkbox" v-model="shown" /> Show</label>
      </div>

      <ul style="margin: 10px 0 0; padding-left: 0; list-style: none">
        <li v-for="c in checks" :key="c.rule">{{ c.met ? '✓' : '✗' }} {{ c.text }}</li>
      </ul>

      <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px">
        <label class="os-check"
          ><input type="checkbox" v-model="forceChangeAtNextLogin" /> User must change password at
          next logon</label
        >
        <label v-if="offerUnlock" class="os-check"
          ><input type="checkbox" v-model="alsoUnlock" /> Unlock the user's account</label
        >
      </div>

      <div v-if="error" class="os-error" style="margin-top: 12px">{{ error }}</div>
      <div v-else-if="copied === false" class="os-error" style="margin-top: 12px">
        Couldn’t copy. Select the password and copy it.
      </div>
      <div v-else-if="historyNote" class="os-info" style="margin-top: 12px">
        {{ historyNote }}
      </div>
    </div>
  </WinDialog>
</template>
