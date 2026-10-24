<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!-- What a new user in this directory gets unless the operator changes it. -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Select from 'primevue/select';
import { PASSWORD_MODES, type NewUserSettings } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { PASSWORD_MODE_LABEL, phoneCountryOptions } from '../../design/lib/newUser.js';
import { errorMessage } from '../../design/lib/errorMessage.js';
import { useAuthStore } from '../../stores/auth.js';

const props = defineProps<{ directoryId: number }>();
const visible = defineModel<boolean>('visible', { required: true });
const emit = defineEmits<{ saved: [newUsers: NewUserSettings] }>();

const auth = useAuthStore();
const form = reactive<NewUserSettings>({
  mailFromUpn: true,
  passwordMode: 'random',
  phoneCountry: null,
});
const saved = ref<NewUserSettings | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

const modeOptions = PASSWORD_MODES.map((value) => ({ value, label: PASSWORD_MODE_LABEL[value] }));
const countryOptions = phoneCountryOptions();
const changed = computed(
  () =>
    !!saved.value &&
    (form.mailFromUpn !== saved.value.mailFromUpn ||
      form.passwordMode !== saved.value.passwordMode ||
      form.phoneCountry !== saved.value.phoneCountry),
);

onMounted(async () => {
  try {
    const r = await api.directories.newUsers.get(props.directoryId);
    saved.value = r.newUsers;
    Object.assign(form, r.newUsers);
  } catch (err) {
    error.value = errorMessage(err, 'Couldn’t load the defaults for new users');
  } finally {
    loading.value = false;
  }
});

function save(): void {
  if (!changed.value || saving.value) return;
  auth.requireStepUp(
    commit,
    'Changing the defaults for new users requires step-up authentication.',
  );
}

async function commit(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const r = await api.directories.newUsers.update(props.directoryId, { ...form });
    emit('saved', r.newUsers);
    visible.value = false;
  } catch (err) {
    if (auth.retryAfterStepUp(err, commit)) return;
    error.value = errorMessage(err, 'Save failed');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :closable="!saving"
    header="New users"
    :style="{ width: 'min(520px, 95vw)' }"
  >
    <form class="form-stack" @submit.prevent="save">
      <p class="hint">
        What the New user form starts with in this directory. The operator can change each one for
        the person they’re creating.
      </p>
      <div class="form-row">
        <label for="nu-password-mode" class="fld-label">Password</label>
        <Select
          v-model="form.passwordMode"
          input-id="nu-password-mode"
          :options="modeOptions"
          option-label="label"
          option-value="value"
          :disabled="loading"
          class="w-full"
        />
        <small class="hint">
          Random suits people who set their own password in Entra ID, with self-service password
          reset and writeback or a Temporary Access Pass.
        </small>
      </div>
      <div class="form-row">
        <label for="nu-country" class="fld-label">Country for phone numbers</label>
        <Select
          v-model="form.phoneCountry"
          input-id="nu-country"
          :options="countryOptions"
          option-label="label"
          option-value="value"
          filter
          show-clear
          placeholder="None: numbers need a country code"
          :disabled="loading"
          class="w-full"
        />
        <small class="hint">Numbers typed without a country code are read as this country’s.</small>
      </div>
      <div class="check-row">
        <Checkbox v-model="form.mailFromUpn" input-id="nu-mail" binary :disabled="loading" />
        <label for="nu-mail">Set email (<span class="mono">mail</span>) to the UPN</label>
      </div>
      <small class="hint">OpenADUC never writes proxyAddresses.</small>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </form>
    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        :disabled="saving"
        @click="visible = false"
      />
      <Button label="Save" :loading="saving" :disabled="!changed" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hint {
  margin: 0;
}
.w-full {
  width: 100%;
}
</style>
