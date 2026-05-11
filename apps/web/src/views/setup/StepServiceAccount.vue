<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Message from 'primevue/message';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

const emit = defineEmits<{ next: []; back: [] }>();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const sameAsAdminConfirmed = ref(false);

const adminUpn = computed<string | null>(() => auth.actor?.username ?? null);

const sameAsAdminCandidate = computed<boolean>(() => {
  const adm = adminUpn.value?.toLowerCase() ?? '';
  if (!adm) return false;
  const typed = username.value.trim().toLowerCase();
  if (!typed) return false;
  const bareTyped = typed.replace(/^.*\\/, '').replace(/@.*$/, '');
  const bareAdmin = adm.replace(/^.*\\/, '').replace(/@.*$/, '');
  return bareTyped === bareAdmin;
});

function validate(): string | null {
  if (!username.value.trim()) return 'Service account username is required';
  if (!password.value) return 'Service account password is required';
  return null;
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  error.value = validate();
  if (error.value) return;
  if (sameAsAdminCandidate.value && !sameAsAdminConfirmed.value) {
    error.value = 'Confirm below to use your admin account, or pick a different one.';
    return;
  }
  submitting.value = true;
  try {
    await api.setup.serviceAccount({
      username: username.value.trim(),
      password: password.value,
    });
    emit('next');
  } catch (err) {
    error.value =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Saving the service account failed';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="step">
    <header class="head">
      <h2 class="title">Add a sync service account</h2>
      <p class="sub">
        OpenADUC reads your directory in the background using a dedicated account.
        <strong>Read-only is enough</strong> — don't grant write permissions.
      </p>
    </header>

    <div class="info">
      <div class="info-icon"><i class="pi pi-shield" /></div>
      <div class="info-body">
        <div class="info-title">What this account needs</div>
        <ul class="info-list">
          <li><strong>Read</strong> on Users, Groups, Computers, OUs across your base DN.</li>
          <li>
            That's it — no reset password, no unlock, no write. A standard Domain User with
            directory read suffices.
          </li>
        </ul>
      </div>
    </div>

    <form class="form" @submit.prevent="submit">
      <div class="row two-col">
        <label class="field">
          <span class="lbl">Service account username</span>
          <InputText
            v-model="username"
            autocomplete="off"
            placeholder="svc-openaduc"
            :disabled="submitting"
            class="w-full"
          />
        </label>
        <label class="field">
          <span class="lbl">Password</span>
          <Password
            v-model="password"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </label>
      </div>
      <p class="hint">
        Bare username, UPN, or
        <span class="mono">DOMAIN\user</span> — we'll attach the directory's domain if you give us
        the bare name.
      </p>

      <Message v-if="sameAsAdminCandidate" severity="warn" :closable="false">
        <strong>Heads up:</strong> this looks like your admin account (<span class="mono">{{
          adminUpn
        }}</span
        >). Using a personal account for sync makes credentials harder to rotate and blurs the audit
        trail.
        <label class="confirm">
          <input v-model="sameAsAdminConfirmed" type="checkbox" :disabled="submitting" />
          <span>I want to proceed with this account.</span>
        </label>
      </Message>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <div class="actions">
        <Button
          type="button"
          label="Back"
          severity="secondary"
          text
          icon="pi pi-arrow-left"
          :disabled="submitting"
          @click="emit('back')"
        />
        <Button
          type="submit"
          label="Test &amp; continue"
          icon="pi pi-arrow-right"
          icon-pos="right"
          :loading="submitting"
        />
      </div>
    </form>
  </div>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: #18181b;
}
.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #18181b;
}
.sub {
  margin: 0;
  font-size: 13px;
  color: #52525b;
  line-height: 1.45;
}

.info {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
}
.info-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #4f46e5;
  color: #ffffff;
  border-radius: 6px;
  font-size: 14px;
}
.info-body {
  flex: 1;
}
.info-title {
  font-size: 12.5px;
  font-weight: 600;
  color: #312e81;
  margin-bottom: 4px;
}
.info-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12.5px;
  color: #3730a3;
  line-height: 1.5;
}
.info-list li {
  margin-bottom: 2px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
@media (max-width: 480px) {
  .row.two-col {
    grid-template-columns: 1fr;
  }
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lbl {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #71717a;
}
.hint {
  margin: -4px 0 0;
  font-size: 11.5px;
  color: #71717a;
}
.mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: #52525b;
}

.confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12.5px;
}
.confirm input {
  accent-color: #4f46e5;
}

.actions {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
}
.w-full {
  width: 100%;
}

:deep(.p-inputtext),
:deep(.p-password .p-password-input) {
  padding: 6px 10px;
  font-size: 13px;
}
:deep(.p-password) {
  display: block;
  width: 100%;
}
:deep(.p-password .p-password-input) {
  width: 100%;
}
:deep(.p-button) {
  padding: 7px 14px;
  font-size: 13px;
}
:deep(.p-message) {
  margin: 0;
  font-size: 12.5px;
}
:deep(.p-message .p-message-wrapper) {
  padding: 10px 14px;
}
</style>
