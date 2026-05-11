<!-- SPDX-License-Identifier: BUSL-1.1
     Classic "Reset Password" dialog. Two password fields,
     "User must change password at next logon" checkbox, "Unlock the
     user's account" checkbox. Routes through useAuth.requireEdit so
     the step-up flow runs before the API call. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import WinDialog from './WinDialog.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';

const props = defineProps<{ id: string; samAccountName: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const auth = useAuthStore();
const store = useOldSchool();
const toast = useToast();
const visible = ref(true);

const newPwd = ref('');
const confirmPwd = ref('');
const mustChange = ref(true);
const alsoUnlock = ref(false);
const err = ref<string | null>(null);

const canOk = computed(() => newPwd.value.length >= 8 && newPwd.value === confirmPwd.value);

async function submit(): Promise<void> {
  if (!canOk.value) {
    err.value =
      newPwd.value.length < 8
        ? 'Password must be at least 8 characters.'
        : 'Passwords do not match.';
    return;
  }
  err.value = null;
  auth.requireEdit(async () => {
    try {
      await api.users.resetPassword(props.id, {
        newPassword: newPwd.value,
        forceChangeAtNextLogin: mustChange.value,
      });
      if (alsoUnlock.value) {
        try {
          await api.users.unlock(props.id);
        } catch {
          // Unlock can fail benignly if the account isn't locked — don't
          // mask the successful password reset.
        }
      }
      toast.add({
        severity: 'success',
        summary: `Password has been changed.`,
        detail: `The password for ${props.samAccountName} has been changed.`,
        life: 4000,
      });
      store.bumpData();
      visible.value = false;
      emit('close');
    } catch (e) {
      err.value = e instanceof ApiError ? e.message : (e as Error).message;
    }
  }, 'Resetting a password requires step-up authentication.');
}
</script>

<template>
  <WinDialog
    :visible="visible"
    :title="`Reset Password`"
    icon="properties"
    :width="440"
    hide-apply
    ok-label="OK"
    :can-ok="canOk"
    @ok="submit"
    @cancel="$emit('close')"
    @update:visible="(v) => !v && $emit('close')"
  >
    <div style="padding: 18px 18px 14px 18px; font-size: 12px">
      <div style="margin-bottom: 14px">
        New password for: <strong>{{ samAccountName }}</strong>
      </div>

      <div class="os-form" style="grid-template-columns: 160px 1fr; row-gap: 8px">
        <label class="label" for="np">New password:</label>
        <input
          id="np"
          type="password"
          class="os-input"
          v-model="newPwd"
          autocomplete="new-password"
        />
        <label class="label" for="cp">Confirm password:</label>
        <input
          id="cp"
          type="password"
          class="os-input"
          v-model="confirmPwd"
          autocomplete="new-password"
        />
      </div>

      <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px">
        <label class="os-check"
          ><input type="checkbox" v-model="mustChange" /> User must change password at next
          logon</label
        >
        <label class="os-check"
          ><input type="checkbox" v-model="alsoUnlock" /> Unlock the user's account</label
        >
      </div>

      <div v-if="err" class="os-error" style="margin-top: 12px">{{ err }}</div>
      <div v-else class="os-info" style="margin-top: 12px">
        The password must comply with your domain's complexity and length requirements.
      </div>
    </div>
  </WinDialog>
</template>
