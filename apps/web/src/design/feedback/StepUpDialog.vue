<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Password from 'primevue/password';
import Message from 'primevue/message';
import { useAuthStore } from '../../stores/auth.js';
import { ApiError } from '../../api/client.js';
import { ELEVATED_SESSION_LIMITS } from '@openaduc/shared';

const props = defineProps<{
  visible: boolean;
  // Optional context shown above the password field — populated when
  // the server refused a write because the elevated session was gone.
  reason?: string | null;
}>();
const emit = defineEmits<{
  'update:visible': [value: boolean];
  ok: [];
  cancel: [];
}>();

const auth = useAuthStore();
const defaultIdle = ELEVATED_SESSION_LIMITS.idleTimeout.default;
const lifetimeMinutes = ELEVATED_SESSION_LIMITS.absoluteLifetime.default;
const defaultLifetime =
  lifetimeMinutes % 60 === 0 ? `${lifetimeMinutes / 60} hours` : `${lifetimeMinutes} minutes`;
const password = ref('');
// The server's generic refusal only says what the explainer below says; a
// reason of its own is lowercase, as server messages are.
const reasonText = computed(() => {
  const reason = props.reason?.trim();
  if (!reason || /^step-up required\b/i.test(reason)) return null;
  const sentence = reason[0]!.toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
});
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

// A held Enter repeats, and an input method's Enter confirms what it composed.
function onEnter(e: KeyboardEvent): void {
  if (e.repeat || e.isComposing || e.keyCode === 229) return;
  void onConfirm();
}

async function onConfirm(): Promise<void> {
  if (submitting.value) return;
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
    <!-- Not a Message: its enter animation grows it from zero height, which
         left the text clipped in the opening dialog. -->
    <p v-if="reasonText" class="dialog-reason" role="alert">{{ reasonText }}</p>
    <p class="dialog-prose">
      Re-enter your AD password to unlock writes. The server uses it to bind as you when applying
      changes. Writes stay unlocked until you've been idle a while or reach a time limit (by default
      {{ defaultIdle }} minutes idle, {{ defaultLifetime }} at most).
    </p>
    <!-- PrimeVue Dialog's onAfterEnter calls focus() which only finds
         elements with the [autofocus] attribute. Without one, it falls
         back to focusing the close X. The `autofocus` prop on Password
         forwards to the underlying input, so the dialog opens with the
         password field focused and ready for typing. -->
    <Password
      v-model="password"
      :input-props="{ 'aria-label': 'Your AD password' }"
      :feedback="false"
      toggle-mask
      input-class="w-full"
      class="w-full"
      :disabled="submitting"
      autocomplete="current-password"
      autofocus
      @keydown.enter="onEnter"
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
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid color-mix(in oklab, var(--amber) 22%, transparent);
  border-radius: 6px;
  background: var(--amber-soft);
  color: var(--amber);
  font-size: 13px;
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
