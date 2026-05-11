<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { api, type PublicDirectorySummary } from '../api/index.js';
import { ApiError } from '../api/client.js';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Wordmark from '../design/primitives/Wordmark.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const directories = ref<PublicDirectorySummary[]>([]);
const directoryId = ref<number | null>(null);
const username = ref('');
const password = ref('');
const submitting = ref(false);
const localError = ref<string | null>(null);
const loadingDirectories = ref(true);
const usernameInput = ref<{ $el?: HTMLElement } | null>(null);

onMounted(async () => {
  try {
    const r = await api.directories.public();
    directories.value = r.directories;
    if (r.directories.length === 0) {
      // No directories configured yet — bounce to setup.
      await router.replace({ name: 'setup' });
      return;
    }
    directoryId.value = r.directories[0]!.id;
    // Focus the username field once the directory list has loaded so the
    // operator can start typing immediately. nextTick lets the disabled state
    // flip off before focus().
    await nextTick();
    const el = usernameInput.value?.$el;
    if (el instanceof HTMLInputElement) el.focus();
    else if (el) (el.querySelector('input') as HTMLInputElement | null)?.focus();
  } catch (err) {
    localError.value = err instanceof ApiError ? err.message : 'Could not load directories';
  } finally {
    loadingDirectories.value = false;
  }
});

async function onSubmit(): Promise<void> {
  if (submitting.value) return;
  if (!directoryId.value) {
    localError.value = 'Pick a domain';
    return;
  }
  if (!username.value || !password.value) {
    localError.value = 'Username and password are required';
    return;
  }
  submitting.value = true;
  localError.value = null;
  try {
    await auth.login({
      directoryId: directoryId.value,
      username: username.value,
      password: password.value,
    });
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    await router.replace(next);
  } catch (err) {
    localError.value =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Sign in failed';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="login-brand">
      <img class="login-mark" src="/branding/logo.png" alt="OpenADUC" />
      <Wordmark class="login-name" />
    </div>

    <section class="dc-card login-card">
      <div class="dc-card-head">
        <div>
          <h3 class="dc-card-title">Sign in</h3>
          <div class="dc-card-sub">Use your Active Directory credentials.</div>
        </div>
      </div>
      <div class="dc-card-body">
        <form class="login-form" @submit.prevent="onSubmit">
          <div class="login-row">
            <label for="domain" class="fld-label">Domain</label>
            <Select
              id="domain"
              v-model="directoryId"
              :options="directories"
              option-label="domain"
              option-value="id"
              class="w-full"
              :disabled="submitting || loadingDirectories"
              :placeholder="loadingDirectories ? 'Loading…' : 'Select a domain'"
            />
          </div>
          <div class="login-row">
            <label for="username" class="fld-label">Username</label>
            <InputText
              id="username"
              ref="usernameInput"
              v-model="username"
              autocomplete="username"
              class="w-full"
              placeholder="user, user@domain, or DOMAIN\user"
              :disabled="submitting"
            />
          </div>
          <div class="login-row">
            <label for="password" class="fld-label">Password</label>
            <Password
              id="password"
              v-model="password"
              :feedback="false"
              toggle-mask
              input-class="w-full"
              class="w-full"
              :disabled="submitting"
              autocomplete="current-password"
            />
          </div>
          <Message v-if="localError || auth.error" severity="error" :closable="false">{{
            localError ?? auth.error
          }}</Message>
          <Button
            type="submit"
            label="Sign in"
            :loading="submitting"
            class="w-full"
            @click="onSubmit"
          />
        </form>
      </div>
    </section>

    <div class="login-foot">v0.1</div>
  </div>
</template>

<style scoped>
.login-shell {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
}

.login-mark {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  object-fit: contain;
  display: block;
}

.login-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.005em;
}

.login-card {
  width: 100%;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.w-full {
  width: 100%;
}

:deep(.p-password) {
  display: block;
  width: 100%;
}

:deep(.p-password .p-password-input) {
  width: 100%;
}

.login-foot {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}
</style>
