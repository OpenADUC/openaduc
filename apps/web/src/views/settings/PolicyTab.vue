<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import InputNumber from 'primevue/inputnumber';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import type { DirectoryPolicy } from '@openaduc/shared';
import { api, type AppSettings } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import Card from '../../design/primitives/Card.vue';

const auth = useAuthStore();
const toast = useToast();

const settings = ref<AppSettings>({});
const loading = ref(true);
const saving = ref(false);
const adPolicy = ref<DirectoryPolicy | null>(null);
const adPolicyLoading = ref(false);
const adPolicyError = ref<string | null>(null);

// Local form state mirrors the settings keys we expose here. Password
// rotation (max-age) is no longer collected — the API derives it from AD's
// domain `maxPwdAge` at request time.
const form = ref({
  passwordExpiringDays: 14,
  staleLogonDays: 60,
  auditAccountView: true,
  auditSearch: false,
});

const canEdit = computed(() => auth.hasCapability('configure:security'));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.settings.list();
    settings.value = r.settings;
    form.value = {
      passwordExpiringDays: numericValue('view.password_expiring_days', 14) ?? 14,
      staleLogonDays: numericValue('view.stale_logon_days', 60) ?? 60,
      auditAccountView: booleanValue('audit.account_view_enabled', true),
      auditSearch: booleanValue('audit.search_enabled', false),
    };
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load settings',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  } finally {
    loading.value = false;
  }
}

function numericValue(key: string, fallback: number | null): number | null {
  const v = settings.value[key]?.value;
  return typeof v === 'number' ? v : fallback;
}

function booleanValue(key: string, fallback: boolean): boolean {
  const v = settings.value[key]?.value;
  return typeof v === 'boolean' ? v : fallback;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    await api.settings.update({
      'view.password_expiring_days': form.value.passwordExpiringDays,
      'view.stale_logon_days': form.value.staleLogonDays,
      'audit.account_view_enabled': form.value.auditAccountView,
      'audit.search_enabled': form.value.auditSearch,
    });
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Save failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    saving.value = false;
  }
}

async function loadAdPolicy(): Promise<void> {
  const dirId = auth.actor?.directoryId;
  if (!dirId) return;
  adPolicyLoading.value = true;
  adPolicyError.value = null;
  try {
    const r = await api.directories.policy(dirId);
    adPolicy.value = r.policy;
  } catch (err) {
    adPolicyError.value = err instanceof Error ? err.message : String(err);
  } finally {
    adPolicyLoading.value = false;
  }
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return 'unknown';
  if (minutes === 0) return 'manual unlock only';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function formatDays(days: number | null): string {
  if (days === null) return 'unknown';
  if (days === 0) return 'never expire';
  return `${days} day${days === 1 ? '' : 's'}`;
}

function formatThreshold(n: number | null): string {
  if (n === null) return 'unknown';
  if (n === 0) return 'lockout disabled';
  return `${n} attempt${n === 1 ? '' : 's'}`;
}

onMounted(async () => {
  await load();
  await loadAdPolicy();
});
</script>

<template>
  <Toast />

  <Card
    title="Active Directory policy (read-only)"
    sub="lockout & password policy from the domain root"
  >
    <p v-if="adPolicyLoading" class="setting-hint">Loading policy from AD…</p>
    <p v-else-if="adPolicyError" class="setting-hint" style="color: var(--danger)">
      Could not read AD policy: {{ adPolicyError }}
    </p>
    <dl v-else-if="adPolicy" class="ad-policy-grid">
      <dt class="fld-label">Lockout threshold</dt>
      <dd>{{ formatThreshold(adPolicy.lockoutThreshold) }}</dd>
      <dt class="fld-label">Lockout duration</dt>
      <dd>{{ formatDuration(adPolicy.lockoutDurationMinutes) }}</dd>
      <dt class="fld-label">Lockout observation window</dt>
      <dd>{{ formatDuration(adPolicy.lockoutObservationMinutes) }}</dd>
      <dt class="fld-label">Max password age</dt>
      <dd>{{ formatDays(adPolicy.maxPwdAgeDays) }}</dd>
      <dt class="fld-label">Min password length</dt>
      <dd>{{ adPolicy.minPwdLength ?? 'unknown' }}</dd>
      <dt class="fld-label">Password history</dt>
      <dd>{{ adPolicy.pwdHistoryLength ?? 'unknown' }}</dd>
    </dl>
    <p class="setting-hint">
      AD enforces these directly. Per-user password expiration is computed from
      <span class="mono">passwordLastSetAt</span> + the
      <span class="mono">Max password age</span> shown above.
    </p>
  </Card>

  <Card
    title="Saved view defaults"
    sub="thresholds the sidebar saved views and dashboard widgets use"
  >
    <div class="form-grid-2">
      <div class="setting-block">
        <label class="fld-label">Password expiring window (days)</label>
        <p class="setting-hint">Used by the "Password expiring" saved view.</p>
        <InputNumber
          v-model="form.passwordExpiringDays"
          :disabled="!canEdit || loading"
          :min="1"
          :max="365"
          class="w-full"
        />
      </div>
      <div class="setting-block">
        <label class="fld-label">Stale logon threshold (days)</label>
        <p class="setting-hint">Used by the "Stale logon" saved view.</p>
        <InputNumber
          v-model="form.staleLogonDays"
          :disabled="!canEdit || loading"
          :min="1"
          :max="3650"
          class="w-full"
        />
      </div>
    </div>
  </Card>

  <Card title="Audit logging" sub="what activities produce audit events">
    <label class="check-row">
      <input v-model="form.auditAccountView" type="checkbox" :disabled="!canEdit || loading" />
      <span>
        <strong>Audit account views</strong>
        <span class="setting-hint"> — every time someone opens a user detail page.</span>
      </span>
    </label>
    <label class="check-row">
      <input v-model="form.auditSearch" type="checkbox" :disabled="!canEdit || loading" />
      <span>
        <strong>Audit user searches</strong>
        <span class="setting-hint">
          — every search produces an event. High volume; off by default.</span
        >
      </span>
    </label>
  </Card>

  <div class="save-row">
    <Button
      v-if="canEdit"
      label="Save changes"
      icon="pi pi-check"
      :loading="saving"
      :disabled="loading"
      @click="save"
    />
    <span v-else class="hint">
      You don't have <span class="mono">configure:security</span> capability — view only.
    </span>
  </div>
</template>

<style scoped>
.setting-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.setting-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
}

.number-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 760px) {
  .form-grid-2 {
    grid-template-columns: 1fr;
  }
}

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 8px 0;
  font-size: 13px;
  color: var(--text);
}

.check-row input {
  margin-top: 3px;
}

.save-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 8px;
}

.w-full {
  width: 100%;
}

:deep(.p-inputnumber) {
  width: 100%;
}

:deep(.p-inputnumber .p-inputtext) {
  width: 100%;
}

.ad-policy-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0 0 8px;
}

@media (min-width: 910px) {
  .ad-policy-grid {
    grid-template-columns: max-content 1fr max-content 1fr;
    grid-template-rows: repeat(3, auto);
    column-gap: 32px;
  }
  .ad-policy-grid > :nth-child(1) {
    grid-area: 1 / 1;
  }
  .ad-policy-grid > :nth-child(2) {
    grid-area: 1 / 2;
  }
  .ad-policy-grid > :nth-child(3) {
    grid-area: 2 / 1;
  }
  .ad-policy-grid > :nth-child(4) {
    grid-area: 2 / 2;
  }
  .ad-policy-grid > :nth-child(5) {
    grid-area: 3 / 1;
  }
  .ad-policy-grid > :nth-child(6) {
    grid-area: 3 / 2;
  }
  .ad-policy-grid > :nth-child(7) {
    grid-area: 1 / 3;
  }
  .ad-policy-grid > :nth-child(8) {
    grid-area: 1 / 4;
  }
  .ad-policy-grid > :nth-child(9) {
    grid-area: 2 / 3;
  }
  .ad-policy-grid > :nth-child(10) {
    grid-area: 2 / 4;
  }
  .ad-policy-grid > :nth-child(11) {
    grid-area: 3 / 3;
  }
  .ad-policy-grid > :nth-child(12) {
    grid-area: 3 / 4;
  }
}

.ad-policy-grid dt {
  align-self: center;
}

.ad-policy-grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
