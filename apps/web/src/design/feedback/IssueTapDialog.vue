<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Issue a Temporary Access Pass to a user, within the tenant's policy, and
  show it once. Closing the dialog forgets the pass.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Message from 'primevue/message';
import { lifetimeLabel, tapExpiresAt, type TapIssueResponse } from '@openaduc/shared';
import { useIssueTap, type TapTarget } from '../composables/useIssueTap.js';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';

const props = defineProps<{
  visible: boolean;
  user: TapTarget | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  issued: [issued: TapIssueResponse];
}>();

const {
  preflight,
  loading,
  error,
  startLater,
  startsAtLocal,
  lifetimeMinutes,
  isUsableOnce,
  lifetimeOptions,
  multiUseAllowed,
  existing,
  problem,
  canIssue,
  submitting,
  issued,
  copied,
  load,
  reload,
  submit,
  copy,
  clear,
} = useIssueTap({ onIssued: (r) => emit('issued', r) });

watch(
  () => props.visible,
  (open) => {
    if (open && props.user) void load(props.user);
    else clear();
  },
  { immediate: true },
);

const name = computed(() => props.user?.displayName ?? props.user?.samAccountName ?? 'this user');

const existingText = computed(() => {
  const held = existing.value;
  if (!held) return null;
  const start = held.startsAt ?? held.createdAt;
  const ends = start && held.lifetimeMinutes ? tapExpiresAt(start, held.lifetimeMinutes) : null;
  const parts = [
    held.isUsableOnce ? 'single-use' : 'multi-use',
    held.usabilityReason === 'NotYetValid' && start
      ? `starts ${fmtAbsolute(start)}`
      : ends
        ? `expires ${fmtRelative(ends)}`
        : null,
  ].filter(Boolean);
  return parts.join(', ');
});

function close(): void {
  if (!submitting.value) emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    class="ds-sheet"
    header="Issue Temporary Access Pass"
    :style="{ width: '30rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && close()"
  >
    <template v-if="issued">
      <p class="tap-intro">
        Give this pass to <strong>{{ name }}</strong
        >. It’s shown only now: OpenADUC doesn’t keep it. If it’s lost, issue another.
      </p>
      <div class="tap-value-row">
        <code class="tap-value" data-testid="tap-value">{{ issued.temporaryAccessPass }}</code>
        <Button
          :icon="copied ? 'pi pi-check' : 'pi pi-copy'"
          :label="copied ? 'Copied' : 'Copy'"
          size="small"
          severity="secondary"
          @click="copy"
        />
      </div>
      <p v-if="copied === false" class="tap-note">Couldn’t copy. Select it and copy it.</p>
      <dl class="tap-facts">
        <dt>Starts</dt>
        <dd>{{ fmtAbsolute(issued.startsAt) }}</dd>
        <dt>Expires</dt>
        <dd>{{ fmtAbsolute(issued.expiresAt) }}</dd>
        <dt>Use</dt>
        <dd>
          {{ issued.isUsableOnce ? 'One sign-in' : 'Any number of sign-ins until it expires' }}
        </dd>
      </dl>
    </template>

    <p v-else-if="loading" class="tap-note">Checking {{ name }} in Microsoft Entra…</p>

    <template v-else-if="preflight?.status === 'refused'">
      <Message severity="warn" :closable="false" class="tap-msg">{{ preflight.message }}</Message>
    </template>

    <template v-else-if="preflight?.status === 'unsynced'">
      <Message severity="info" :closable="false" class="tap-msg">
        {{ name }} isn’t in Microsoft Entra yet. They appear when Connect Sync next runs, which
        can’t be started from here.
        <template v-if="preflight.lastSyncAt">
          The tenant last synced {{ fmtRelative(preflight.lastSyncAt) }} ({{
            fmtAbsolute(preflight.lastSyncAt)
          }}).
        </template>
        <template v-else>The tenant’s last sync time isn’t available.</template>
      </Message>
    </template>

    <template v-else-if="preflight?.status === 'ready'">
      <p class="tap-intro">
        A Temporary Access Pass lets <strong>{{ name }}</strong> sign in to Microsoft Entra without
        a password and register their own sign-in methods. Whoever holds it can sign in as them.
      </p>

      <Message
        v-if="preflight.inPolicyScope === false"
        severity="warn"
        :closable="false"
        class="tap-msg"
      >
        {{ name }} isn’t among the users the tenant’s Temporary Access Pass policy covers, so
        Microsoft Entra may not accept a pass for them. Add them to the policy in the Microsoft
        Entra admin center first.
      </Message>
      <Message v-if="existing" severity="warn" :closable="false" class="tap-msg">
        {{ name }} already has a pass ({{ existingText }}). Issuing a new one replaces it, and the
        old one stops working.
      </Message>

      <fieldset class="tap-group">
        <legend class="fld-label">Starts</legend>
        <label class="tap-choice">
          <input v-model="startLater" type="radio" :value="false" :disabled="submitting" />
          <span>Now</span>
        </label>
        <label class="tap-choice">
          <input v-model="startLater" type="radio" :value="true" :disabled="submitting" />
          <span>Later</span>
        </label>
        <InputText
          v-if="startLater"
          v-model="startsAtLocal"
          type="datetime-local"
          class="tap-start"
          aria-label="When the pass starts"
          :disabled="submitting"
        />
      </fieldset>

      <label for="tap-lifetime" class="fld-label">Lifetime</label>
      <Select
        v-model="lifetimeMinutes"
        input-id="tap-lifetime"
        :options="lifetimeOptions"
        option-label="label"
        option-value="value"
        fluid
        :disabled="submitting"
      />
      <p class="tap-note">
        The tenant allows {{ lifetimeLabel(preflight.policy.minLifetimeMinutes) }} to
        {{ lifetimeLabel(preflight.policy.maxLifetimeMinutes) }}.
      </p>

      <label class="tap-choice">
        <input v-model="isUsableOnce" type="checkbox" :disabled="submitting || !multiUseAllowed" />
        <span>One sign-in only</span>
      </label>
      <p v-if="!multiUseAllowed" class="tap-note">The tenant allows only single-use passes.</p>
      <p v-if="problem" class="tap-problem">{{ problem }}</p>
    </template>

    <Message v-if="error" severity="error" :closable="false" class="tap-msg">{{ error }}</Message>

    <template #footer>
      <template v-if="issued">
        <Button label="Done" @click="close" />
      </template>
      <template v-else>
        <Button label="Cancel" text severity="secondary" :disabled="submitting" @click="close" />
        <Button
          v-if="preflight?.status === 'unsynced' || (!preflight && error)"
          label="Check again"
          severity="secondary"
          :loading="loading"
          @click="reload"
        />
        <Button
          v-if="preflight?.status === 'ready'"
          :label="existing ? 'Replace pass' : 'Issue pass'"
          :severity="existing ? 'danger' : undefined"
          :loading="submitting"
          :disabled="!canIssue"
          @click="submit"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.tap-intro {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
}

.tap-msg {
  margin: 0 0 12px;
}

.tap-group {
  border: 0;
  margin: 0 0 12px;
  padding: 0;
}

.tap-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 13px;
  color: var(--text-2);
}

.tap-start {
  margin: 2px 0 0 24px;
  width: calc(100% - 24px);
}

.tap-note {
  margin: 4px 0 10px;
  font-size: 11.5px;
  color: var(--text-3);
}

.tap-problem {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--danger-text, #b00020);
}

.tap-value-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.tap-value {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 18px;
  letter-spacing: 0.04em;
  user-select: all;
  word-break: break-all;
}

.tap-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin: 12px 0 0;
  font-size: 12.5px;
}

.tap-facts dt {
  color: var(--text-3);
}

.tap-facts dd {
  margin: 0;
  color: var(--text);
}

@media (max-width: 767.98px) {
  .tap-choice {
    min-height: var(--tap-target);
    margin: 0;
  }

  .tap-choice input {
    width: 18px;
    height: 18px;
  }
}
</style>
