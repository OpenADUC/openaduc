<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import type { LdapTlsMode } from '@openaduc/shared';

defineProps<{ disabled?: boolean }>();
const mode = defineModel<LdapTlsMode>({ required: true });

const OPTIONS: { value: LdapTlsMode; label: string; hint: string }[] = [
  { value: 'ldaps', label: 'LDAPS', hint: 'TLS from the start, usually port 636. Recommended.' },
  {
    value: 'starttls',
    label: 'StartTLS',
    hint: 'Connects on the LDAP port (usually 389) and switches to TLS before signing in.',
  },
];
</script>

<template>
  <fieldset class="tls-mode" :disabled="disabled">
    <legend class="lbl">Connection security</legend>
    <label v-for="o in OPTIONS" :key="o.value" class="opt">
      <input v-model="mode" type="radio" :value="o.value" />
      <span>
        <span class="opt-label">{{ o.label }}</span>
        <span class="opt-hint">{{ o.hint }}</span>
      </span>
    </label>
  </fieldset>
</template>

<style scoped>
.tls-mode {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lbl {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
  padding: 0;
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.opt input {
  margin-top: 3px;
}
.opt-label {
  font-weight: 600;
  margin-right: 6px;
}
.opt-hint {
  opacity: 0.75;
}
</style>
