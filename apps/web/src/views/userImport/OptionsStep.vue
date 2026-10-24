<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!-- Step 5: what every account in the import gets: its password, must-change, enabled, mail. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import { PASSWORD_MODES, type PasswordMode } from '@openaduc/shared';
import type { useUserImport } from '../../design/composables/useUserImport.js';
import { PASSWORD_MODE_LABEL } from '../../design/lib/newUser.js';

const props = defineProps<{ wizard: ReturnType<typeof useUserImport> }>();
const w = props.wizard;
const { draft, password, passwordChecks, mustChangeNote } = w;

const shown = ref(false);
const modeOptions = PASSWORD_MODES.map((value) => ({
  value,
  label:
    value === 'set'
      ? 'One for everyone'
      : value === 'generate'
        ? 'Generated for each'
        : PASSWORD_MODE_LABEL[value],
}));
const mode = computed({
  get: () => draft.options.passwordMode,
  set: (m: PasswordMode) => w.setPasswordMode(m),
});
</script>

<template>
  <div class="op">
    <h3 class="op-title">Password</h3>
    <SelectButton
      v-model="mode"
      :options="modeOptions"
      option-label="label"
      option-value="value"
      :allow-empty="false"
      aria-label="Password"
    />
    <p v-if="draft.options.passwordMode === 'random'" class="op-note">
      A long random password nobody sees, for people who set their own in Entra ID (self-service
      password reset with writeback, or a Temporary Access Pass).
    </p>
    <p v-else-if="draft.options.passwordMode === 'generate'" class="op-note">
      Each account gets its own password, made when the import runs. They’re handed over once, in
      the import’s results.
    </p>
    <template v-else>
      <p class="op-note">
        Every account gets the password typed here. It isn’t kept with the draft, so a reload asks
        for it again.
      </p>
      <div class="op-password">
        <InputText
          v-model="password"
          :type="shown ? 'text' : 'password'"
          class="mono"
          aria-label="Password for every account"
          autocomplete="new-password"
          spellcheck="false"
          fluid
        />
        <Button
          :icon="shown ? 'pi pi-eye-slash' : 'pi pi-eye'"
          text
          severity="secondary"
          :aria-label="shown ? 'Hide password' : 'Show password'"
          @click="shown = !shown"
        />
      </div>
      <ul class="op-checks">
        <li v-for="c in passwordChecks" :key="c.rule" :class="{ met: c.met }">
          <i :class="c.met ? 'pi pi-check' : 'pi pi-times'" aria-hidden="true" />
          {{ c.text }}
        </li>
      </ul>
      <p class="op-note">The final check makes sure it holds no one’s logon or display name.</p>
    </template>

    <label class="op-check">
      <input
        type="checkbox"
        :checked="draft.options.passwordMode !== 'random' && draft.options.mustChange"
        :disabled="draft.options.passwordMode === 'random'"
        @change="draft.options.mustChange = ($event.target as HTMLInputElement).checked"
      />
      <span>Must change password at next sign-in</span>
    </label>
    <p v-if="mustChangeNote" class="op-note op-indent">{{ mustChangeNote }}</p>

    <h3 class="op-title">Accounts</h3>
    <label class="op-check">
      <input v-model="draft.options.enabled" type="checkbox" />
      <span>Enable the accounts</span>
    </label>
    <label class="op-check">
      <input v-model="draft.options.mailFromUpn" type="checkbox" />
      <span>Set email to the UPN for rows without an email</span>
    </label>
  </div>
</template>

<style scoped>
.op {
  max-width: 40rem;
}

.op-title {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.op-title:first-child {
  margin-top: 0;
}

.op-note {
  margin: 6px 0 10px;
  font-size: 12px;
  color: var(--text-3);
}

.op-indent {
  margin: -4px 0 10px 24px;
}

.op-password {
  display: flex;
  align-items: center;
  gap: 2px;
}

.op-checks {
  list-style: none;
  margin: 4px 0 8px;
  padding: 0;
  font-size: 12px;
  color: var(--text-3);
}

.op-checks li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.op-checks li.met {
  color: var(--text-2);
}

.op-checks li.met .pi {
  color: var(--green);
}

.op-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--text-2);
}

.mono {
  font-family: var(--font-mono);
}
</style>
