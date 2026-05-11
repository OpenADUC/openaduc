<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Password from 'primevue/password';
import Message from 'primevue/message';
import { api, type DirectoryAdminBody, type SetupExistingDirectory } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

interface Props {
  existing: SetupExistingDirectory | null;
}
const props = defineProps<Props>();
const emit = defineEmits<{ next: [] }>();
const auth = useAuthStore();

interface DcEntry {
  host: string;
}

function dcsFromUrls(urls: string[]): DcEntry[] {
  if (!urls.length) return [{ host: '' }];
  return urls.map((u) => ({
    host: u.replace(/^ldaps?:\/\//i, '').replace(/:\d+$/, ''),
  }));
}

function inferTlsFromUrls(urls: string[]): { useTls: boolean; port: number } {
  const first = urls[0] ?? '';
  const useTls = /^ldaps:/i.test(first) || !/^ldap:/i.test(first);
  const portMatch = first.match(/:(\d+)$/);
  const port = portMatch ? Number(portMatch[1]) : useTls ? 636 : 389;
  return { useTls, port };
}

const initial = props.existing;
const inferred = initial ? inferTlsFromUrls(initial.ldapUrls) : { useTls: true, port: 636 };

const form = reactive({
  domain: initial?.domain ?? '',
  baseDn: initial?.baseDn ?? '',
  baseDnTouched: !!initial,
  useTls: inferred.useTls,
  port: inferred.port,
  // Default OFF: most first-time setups happen against lab DCs with
  // self-signed certs. Operators can flip it back on once their CA
  // chain is trusted.
  rejectUntrusted: initial?.tlsRejectUnauthorized ?? false,
  dcs: initial ? dcsFromUrls(initial.ldapUrls) : ([{ host: '' }] as DcEntry[]),
});

const adminUsername = ref('');
const adminPassword = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const showAdvanced = ref(false);

watch(
  () => form.domain,
  (next) => {
    if (form.baseDnTouched) return;
    const trimmed = next.trim();
    if (!trimmed) {
      form.baseDn = '';
      return;
    }
    form.baseDn = trimmed
      .split('.')
      .filter(Boolean)
      .map((p) => `DC=${p}`)
      .join(',');
  },
);

watch(
  () => form.useTls,
  (useTls) => {
    if (form.port === 389 || form.port === 636) {
      form.port = useTls ? 636 : 389;
    }
  },
);

function ldapUrlFromHost(hostRaw: string): string {
  const host = hostRaw.trim();
  if (!host) return '';
  if (/^ldaps?:\/\//i.test(host)) return host;
  return `${form.useTls ? 'ldaps' : 'ldap'}://${host}:${form.port}`;
}

function buildBody(): Omit<DirectoryAdminBody, 'adminUsername' | 'adminPassword'> {
  return {
    name: form.domain.trim() || 'default',
    domain: form.domain.trim(),
    baseDn: form.baseDn.trim(),
    ldapUrls: form.dcs.map((d) => ldapUrlFromHost(d.host)).filter(Boolean),
    tlsMode: form.useTls ? 'ldaps' : 'plain',
    tlsRejectUnauthorized: form.rejectUntrusted,
  };
}

function validate(): string | null {
  const built = buildBody();
  if (!built.domain) return 'Domain is required';
  if (!built.baseDn) return 'Base DN is required';
  if (built.ldapUrls.length === 0) return 'At least one domain controller is required';
  if (!adminUsername.value.trim()) return 'Admin username is required';
  if (!adminPassword.value) return 'Admin password is required';
  return null;
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  error.value = validate();
  if (error.value) return;
  submitting.value = true;
  try {
    const result = await api.setup.initialize({
      ...buildBody(),
      adminUsername: adminUsername.value.trim(),
      adminPassword: adminPassword.value,
    });
    auth.actor = result.actor;
    emit('next');
  } catch (err) {
    error.value =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Setup failed';
  } finally {
    submitting.value = false;
  }
}

function addDc(): void {
  if (form.dcs.length < 10) form.dcs.push({ host: '' });
}
function removeDc(idx: number): void {
  form.dcs.splice(idx, 1);
  if (form.dcs.length === 0) form.dcs.push({ host: '' });
}
</script>

<template>
  <div class="step">
    <header class="head">
      <h2 class="title">Connect to your domain</h2>
      <p class="sub">
        Enter your DC and an admin account. We bind once to verify the connection and sign you in.
      </p>
    </header>

    <form class="form" @submit.prevent="submit">
      <div class="row two-col">
        <label class="field">
          <span class="lbl">Domain</span>
          <InputText
            v-model="form.domain"
            placeholder="corp.example.com"
            autocomplete="off"
            :disabled="submitting"
            class="w-full"
          />
        </label>
        <label class="field">
          <span class="lbl">Base DN</span>
          <InputText
            v-model="form.baseDn"
            placeholder="DC=corp,DC=example,DC=com"
            autocomplete="off"
            :disabled="submitting"
            class="w-full"
            @input="form.baseDnTouched = true"
          />
        </label>
      </div>

      <div class="row">
        <span class="lbl">Domain controllers</span>
        <div v-for="(_, idx) in form.dcs" :key="idx" class="dc-row">
          <InputText
            v-model="form.dcs[idx]!.host"
            :placeholder="`dc${idx + 1}.${form.domain || 'corp.example.com'}`"
            class="flex-1"
            :disabled="submitting"
          />
          <Button
            v-if="form.dcs.length > 1"
            icon="pi pi-times"
            severity="secondary"
            text
            type="button"
            :disabled="submitting"
            class="icon-btn"
            @click="removeDc(idx)"
          />
        </div>
        <button
          v-if="form.dcs.length < 10"
          type="button"
          class="add-dc"
          :disabled="submitting"
          @click="addDc"
        >
          <i class="pi pi-plus" /> Add another
        </button>
      </div>

      <div class="advanced-toggle">
        <button type="button" class="link" @click="showAdvanced = !showAdvanced">
          <i :class="showAdvanced ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
          {{ showAdvanced ? 'Hide' : 'Show' }} TLS options
        </button>
      </div>

      <div v-if="showAdvanced" class="advanced">
        <label class="check">
          <input v-model="form.useTls" type="checkbox" :disabled="submitting" />
          <span>Use TLS (LDAPS)</span>
        </label>
        <label class="field inline">
          <span class="lbl">Port</span>
          <InputNumber
            v-model="form.port"
            :use-grouping="false"
            :min="1"
            :max="65535"
            input-class="port-input"
            :disabled="submitting"
          />
        </label>
        <label class="check">
          <input v-model="form.rejectUntrusted" type="checkbox" :disabled="submitting" />
          <span>Reject untrusted certs</span>
        </label>
      </div>

      <div class="divider" />

      <div class="row two-col">
        <label class="field">
          <span class="lbl">Admin username</span>
          <InputText
            v-model="adminUsername"
            autocomplete="username"
            placeholder="administrator"
            :disabled="submitting"
            class="w-full"
          />
        </label>
        <label class="field">
          <span class="lbl">Password</span>
          <Password
            v-model="adminPassword"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
            autocomplete="current-password"
            :disabled="submitting"
          />
        </label>
      </div>
      <p class="hint">
        We'll attach <span class="mono">@{{ form.domain || 'domain' }}</span> automatically. UPN or
        <span class="mono">DOMAIN\user</span> also fine.
      </p>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <div class="actions">
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

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
.field.inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.lbl {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #71717a;
}
.hint {
  margin: 0;
  font-size: 11.5px;
  color: #71717a;
}
.mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: #52525b;
}

.dc-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.flex-1 {
  flex: 1;
}
.w-full {
  width: 100%;
}

.add-dc {
  border: 1px dashed #d4d4d8;
  background: transparent;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #52525b;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}
.add-dc:hover:not(:disabled) {
  border-color: #4f46e5;
  color: #4f46e5;
}
.add-dc:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.advanced-toggle {
  display: flex;
  justify-content: flex-start;
}
.link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: #52525b;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.link:hover {
  color: #4f46e5;
}

.advanced {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  padding: 10px 12px;
  background: #f5f5f7;
  border: 1px solid #e7e7ea;
  border-radius: 8px;
}

.divider {
  height: 1px;
  background: #e7e7ea;
  margin: 4px 0;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #18181b;
}
.check input {
  accent-color: #4f46e5;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

/* Compact PrimeVue inputs inside the wizard. The defaults are sized for
   standalone forms; in a wizard with many fields they push everything
   below the fold. */
:deep(.p-inputtext),
:deep(.p-password .p-password-input),
:deep(.p-inputnumber-input) {
  padding: 6px 10px;
  font-size: 13px;
}
:deep(.port-input) {
  width: 70px;
  text-align: center;
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
:deep(.icon-btn.p-button) {
  padding: 4px 8px;
}

:deep(.p-message) {
  margin: 0;
  font-size: 12.5px;
}
:deep(.p-message .p-message-wrapper) {
  padding: 8px 12px;
}
</style>
