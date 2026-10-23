<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Reset a user's password, and unlock the account in the same change when
  it's locked. The check, generator and submit live in usePasswordReset.
-->
<script setup lang="ts">
import { watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import {
  usePasswordReset,
  type ResetOutcome,
  type ResetTarget,
} from '../composables/usePasswordReset.js';

const props = defineProps<{
  visible: boolean;
  user: ResetTarget | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  reset: [outcome: ResetOutcome];
}>();

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
  submitting,
  error,
  load,
  generate,
  copy,
  submit,
} = usePasswordReset({
  onReset: (outcome) => {
    emit('reset', outcome);
    emit('update:visible', false);
  },
});

watch(
  () => props.visible,
  (open) => {
    if (!open || !props.user) return;
    void load(props.user.id);
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
    header="Reset password"
    :style="{ width: '30rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && close()"
  >
    <p class="rp-intro">
      Set a new password for <strong>{{ user?.displayName ?? user?.samAccountName }}</strong
      >.
    </p>

    <label for="reset-new-password" class="fld-label">New password</label>
    <div class="rp-input">
      <InputText
        id="reset-new-password"
        v-model="password"
        :type="shown ? 'text' : 'password'"
        class="rp-value"
        autocomplete="new-password"
        spellcheck="false"
        fluid
        :disabled="submitting"
        @keyup.enter="submit"
      />
      <Button
        :icon="shown ? 'pi pi-eye-slash' : 'pi pi-eye'"
        text
        severity="secondary"
        :aria-label="shown ? 'Hide password' : 'Show password'"
        @click="shown = !shown"
      />
      <Button
        :icon="copied ? 'pi pi-check' : 'pi pi-copy'"
        text
        severity="secondary"
        aria-label="Copy password"
        :disabled="!password"
        @click="copy"
      />
    </div>
    <div class="rp-tools">
      <Button
        label="Generate"
        icon="pi pi-refresh"
        size="small"
        text
        :disabled="submitting"
        @click="generate"
      />
      <span v-if="copied === false" class="rp-note">Couldn’t copy. Select it and copy it.</span>
    </div>

    <ul class="rp-checks">
      <li v-for="c in checks" :key="c.rule" :class="{ met: c.met }">
        <i :class="c.met ? 'pi pi-check' : 'pi pi-times'" aria-hidden="true" />
        {{ c.text }}
      </li>
    </ul>
    <p v-if="historyNote" class="rp-note">{{ historyNote }}</p>

    <label class="rp-check">
      <input v-model="forceChangeAtNextLogin" type="checkbox" :disabled="submitting" />
      <span>Force change at next sign-in</span>
    </label>
    <label v-if="offerUnlock" class="rp-check">
      <input v-model="alsoUnlock" type="checkbox" :disabled="submitting" />
      <span>Also unlock the account</span>
    </label>

    <Message v-if="error" severity="error" :closable="false" class="rp-msg">{{ error }}</Message>

    <template #footer>
      <Button label="Cancel" text severity="secondary" :disabled="submitting" @click="close" />
      <Button
        label="Reset"
        :loading="submitting"
        :disabled="loading || !acceptable"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.rp-intro {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text);
}

.rp-input {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
}

.rp-value {
  flex: 1;
  font-family: var(--font-mono);
}

.rp-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 8px -8px;
}

.rp-checks {
  list-style: none;
  margin: 0 0 6px;
  padding: 0;
  font-size: 12px;
  color: var(--text-3);
}

.rp-checks li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}

.rp-checks li.met {
  color: var(--text-2);
}

.rp-checks li.met .pi {
  color: var(--green);
}

.rp-checks .pi {
  font-size: 11px;
}

.rp-note {
  margin: 0 0 12px;
  font-size: 11.5px;
  color: var(--text-3);
}

.rp-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--text-2);
}

.rp-msg {
  margin: 8px 0 0;
}
</style>
