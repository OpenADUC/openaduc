<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Button from 'primevue/button';
import InputNumber from 'primevue/inputnumber';
import Message from 'primevue/message';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';

const emit = defineEmits<{ next: []; back: [] }>();

// Password expiry itself comes from the AD domain `maxPwdAge` at request
// time — the wizard no longer collects a rotation override. These two
// settings are display-only thresholds for the dashboard widgets and saved
// views, with no AD equivalent.
const passwordExpiringDays = ref<number>(7);
const staleLogonDays = ref<number>(60);

const loading = ref(true);
const submitting = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const { settings } = await api.settings.list();
    const warn = settings['view.password_expiring_days']?.value;
    if (typeof warn === 'number') passwordExpiringDays.value = warn;
    const stale = settings['view.stale_logon_days']?.value;
    if (typeof stale === 'number') staleLogonDays.value = stale;
  } catch {
    // Defaults are fine — operator can still proceed.
  } finally {
    loading.value = false;
  }
});

async function submit(): Promise<void> {
  if (submitting.value) return;
  if (
    !passwordExpiringDays.value ||
    passwordExpiringDays.value < 1 ||
    passwordExpiringDays.value > 365
  ) {
    error.value = 'Warning window must be between 1 and 365 days';
    return;
  }
  if (!staleLogonDays.value || staleLogonDays.value < 1 || staleLogonDays.value > 3650) {
    error.value = 'Stale-login threshold must be between 1 and 3650 days';
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    await api.setup.policy({
      passwordExpiringDays: passwordExpiringDays.value,
      staleLogonDays: staleLogonDays.value,
    });
    emit('next');
  } catch (err) {
    error.value =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Saving policy failed';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="step">
    <header class="head">
      <h2 class="title">Password &amp; activity policy</h2>
      <p class="sub">
        OpenADUC uses these to flag aging passwords and idle accounts. Change any time from Settings
        → Security.
      </p>
    </header>

    <div v-if="loading" class="loading">Loading current values…</div>

    <form v-else class="form" @submit.prevent="submit">
      <div class="setting">
        <div class="setting-text">
          <div class="setting-name">Warn when expiring within</div>
          <p class="setting-desc">
            Users whose password expires inside this window are flagged on the dashboard.
          </p>
        </div>
        <div class="setting-input">
          <InputNumber
            v-model="passwordExpiringDays"
            :min="1"
            :max="365"
            :use-grouping="false"
            input-class="num-input"
            :disabled="submitting"
          />
          <span class="suffix">days</span>
        </div>
      </div>

      <div class="setting">
        <div class="setting-text">
          <div class="setting-name">Mark login stale after</div>
          <p class="setting-desc">
            Accounts inactive for this long appear in the stale-users view.
          </p>
        </div>
        <div class="setting-input">
          <InputNumber
            v-model="staleLogonDays"
            :min="1"
            :max="3650"
            :use-grouping="false"
            input-class="num-input"
            :disabled="submitting"
          />
          <span class="suffix">days</span>
        </div>
      </div>

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
          label="Save &amp; continue"
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
  gap: 16px;
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

.loading {
  color: #71717a;
  font-family: var(--font-mono);
  font-size: 12.5px;
  padding: 16px 0;
  text-align: center;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.setting {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  background: #fafafa;
  border: 1px solid #e7e7ea;
  border-radius: 8px;
}
.setting-text {
  flex: 1;
  min-width: 0;
}
.setting-name {
  font-size: 13.5px;
  font-weight: 600;
  color: #18181b;
  margin-bottom: 2px;
}
.setting-desc {
  margin: 0;
  font-size: 12px;
  color: #71717a;
  line-height: 1.45;
}
.setting-input {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.suffix {
  font-size: 12.5px;
  color: #71717a;
}

.actions {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
}

:deep(.num-input) {
  width: 76px;
  text-align: center;
  padding: 6px 10px;
  font-size: 13px;
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
  padding: 8px 12px;
}
</style>
