<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Pick the last day a user's account works, or that it never expires.
  Renders a useAccountExpiry the page owns, so the page can show a failed
  Undo and say what the expiry became.
-->
<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import DatePicker from 'primevue/datepicker';
import Message from 'primevue/message';
import type { ExpiryFailure, useAccountExpiry } from '../composables/useAccountExpiry.js';
import { expiryText } from '../lib/accountExpiry.js';
import { fmtRelative } from '../lib/format.js';

const props = defineProps<{
  visible: boolean;
  expiry: ReturnType<typeof useAccountExpiry>;
  /** The failed write to show here, as placeFailure places it. */
  failure: ExpiryFailure | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { account, never, endOf, ready, submitting } = props.expiry;

const today = new Date(new Date().setHours(0, 0, 0, 0));

const current = computed(() => {
  const at = account.value?.accountExpiresAt ?? null;
  if (at && Date.parse(at) <= Date.now()) return `Expired ${fmtRelative(at)}`;
  const text = expiryText(at);
  return text[0]!.toUpperCase() + text.slice(1);
});

function pick(day: Date | Date[] | (Date | null)[] | null | undefined): void {
  endOf.value = day instanceof Date ? day : null;
  if (endOf.value) never.value = false;
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Account expiry"
    :style="{ width: '26rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && emit('close')"
  >
    <p class="ae-intro">
      Choose the last day <strong>{{ account?.name }}</strong> can sign in.
    </p>
    <p class="ae-current">{{ current }}</p>

    <label class="ae-choice">
      <input
        type="radio"
        name="account-expiry"
        :checked="!never"
        :disabled="submitting"
        @change="never = false"
      />
      <span>End of</span>
    </label>
    <DatePicker
      :model-value="endOf"
      :min-date="today"
      placeholder="Pick a day"
      show-icon
      icon-display="input"
      fluid
      class="ae-date"
      input-id="account-expiry-day"
      aria-label="Last day the account works"
      :disabled="submitting"
      @update:model-value="pick"
    />
    <label class="ae-choice">
      <input
        type="radio"
        name="account-expiry"
        :checked="never"
        :disabled="submitting"
        @change="never = true"
      />
      <span>Never expires</span>
    </label>

    <Message v-if="failure" severity="error" closable class="ae-msg" @close="expiry.dismiss">
      {{ failure.message }}
    </Message>

    <template #footer>
      <Button
        label="Cancel"
        text
        severity="secondary"
        :disabled="submitting"
        @click="emit('close')"
      />
      <Button label="Save" :loading="submitting" :disabled="!ready" @click="expiry.submit" />
    </template>
  </Dialog>
</template>

<style scoped>
.ae-intro {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--text);
}

.ae-current {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-3);
}

.ae-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--text-2);
}

.ae-date {
  margin: 0 0 12px 24px;
  width: calc(100% - 24px);
}

.ae-msg {
  margin: 8px 0 0;
}
</style>
