<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Password from 'primevue/password';
import Message from 'primevue/message';
import { useAuthStore } from '../../stores/auth.js';
import { ApiError } from '../../api/client.js';

const props = defineProps<{
  visible: boolean;
  // Optional context shown above the password field — populated when
  // the dialog opened automatically (e.g. "your editing session
  // expired") rather than from a click on the editing toggle.
  reason?: string | null;
}>();
const emit = defineEmits<{
  'update:visible': [value: boolean];
  ok: [];
  cancel: [];
}>();

const auth = useAuthStore();
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.visible,
  (open) => {
    if (open) {
      password.value = '';
      error.value = null;
    }
  },
);

async function onConfirm(): Promise<void> {
  if (!password.value) {
    error.value = 'Password required';
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    await auth.stepUp(password.value);
    emit('update:visible', false);
    emit('ok');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Step-up failed';
  } finally {
    submitting.value = false;
  }
}

function onCancel(): void {
  emit('update:visible', false);
  emit('cancel');
}
</script>

<template>
  <Dialog
    :visible="visible"
    @update:visible="(v) => emit('update:visible', v)"
    modal
    header="Confirm your identity"
    :style="{ width: '26rem' }"
    :closable="!submitting"
  >
    <Message v-if="reason" severity="warn" :closable="false" class="dialog-reason">
      {{ reason }}
    </Message>
    <p class="dialog-prose">
      Re-enter your AD password to authorize sensitive actions for the next session. The server uses
      this to bind as you when applying changes.
    </p>
    <!-- PrimeVue Dialog's onAfterEnter calls focus() which only finds
         elements with the [autofocus] attribute. Without one, it falls
         back to focusing the close X. The `autofocus` prop on Password
         forwards to the underlying input, so the dialog opens with the
         password field focused and ready for typing. -->
    <Password
      v-model="password"
      :feedback="false"
      toggle-mask
      input-class="w-full"
      class="w-full"
      :disabled="submitting"
      autocomplete="current-password"
      autofocus
      @keyup.enter="onConfirm"
    />
    <Message v-if="error" severity="error" :closable="false" class="dialog-error">{{
      error
    }}</Message>
    <template #footer>
      <Button label="Cancel" text severity="secondary" :disabled="submitting" @click="onCancel" />
      <Button label="Confirm" :loading="submitting" @click="onConfirm" />
    </template>
  </Dialog>
</template>

<style scoped>
.dialog-prose {
  font-size: 13px;
  color: var(--text-2);
  margin: 0 0 12px;
}

.dialog-reason {
  margin-bottom: 12px !important;
}

.dialog-error {
  margin-top: 10px !important;
}

:deep(.p-password) {
  display: block;
  width: 100%;
}

:deep(.p-password .p-password-input) {
  width: 100%;
}
</style>
