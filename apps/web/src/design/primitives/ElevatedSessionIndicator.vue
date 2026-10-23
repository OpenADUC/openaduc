<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { useAuthStore } from '../../stores/auth.js';
import { ApiError } from '../../api/client.js';

// Sits by the operator's name while an elevated session lives. Deliberately
// quiet: a clock time rather than a ticking countdown, since activity keeps
// moving the idle end and the next write simply prompts step-up again.
defineProps<{ compact?: boolean }>();

const auth = useAuthStore();
const toast = useToast();
const ending = ref(false);

// The server caps the idle end at the absolute end; once they meet, activity
// no longer moves it, so "if idle" would mislead.
const until = computed(() => {
  const iso = auth.elevatedIdleEndsAt;
  if (!iso) return null;
  const time = new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return iso === auth.actor?.elevated.absoluteExpiresAt ? `until ${time}` : `until ${time} if idle`;
});
const summary = computed(() =>
  until.value ? `Writes unlocked ${until.value}` : 'Writes unlocked',
);

async function end(): Promise<void> {
  ending.value = true;
  try {
    await auth.revokeStepUp();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: "Couldn't end the elevated session",
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    ending.value = false;
  }
}
</script>

<template>
  <div v-if="auth.elevated" class="elevated-indicator" :class="{ compact }" role="status">
    <button
      v-if="compact"
      v-tooltip.right="`${summary}. Click to lock writes now.`"
      type="button"
      class="ei-icon-btn"
      aria-label="End elevated session"
      :disabled="ending"
      @click="end"
    >
      <i class="pi pi-lock-open" aria-hidden="true" />
    </button>
    <template v-else>
      <i class="pi pi-lock-open ei-icon" aria-hidden="true" />
      <span class="ei-text">
        <span class="ei-label">Writes unlocked</span>
        <span v-if="until" class="ei-sub">{{ until }}</span>
      </span>
      <button
        type="button"
        class="ei-end"
        aria-label="End elevated session"
        :title="`${summary}. Lock writes now.`"
        :disabled="ending"
        @click="end"
      >
        Lock
      </button>
    </template>
  </div>
</template>

<style scoped>
.elevated-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  color: var(--text-2);
  font-size: 12px;
  min-width: 0;
}

.elevated-indicator.compact {
  justify-content: center;
  padding: 0;
}

.ei-icon {
  color: var(--accent);
  font-size: 13px;
  flex: 0 0 auto;
}

.ei-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
  flex: 1;
}

.ei-label {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ei-sub {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ei-end,
.ei-icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-2);
  cursor: pointer;
  flex: 0 0 auto;
}

.ei-end {
  font-size: 11.5px;
  padding: 2px 8px;
}

.ei-icon-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: var(--accent);
  font-size: 13px;
}

.ei-end:hover:not(:disabled),
.ei-icon-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.ei-end:focus-visible,
.ei-icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.ei-end:disabled,
.ei-icon-btn:disabled {
  cursor: progress;
  opacity: 0.7;
}
</style>
