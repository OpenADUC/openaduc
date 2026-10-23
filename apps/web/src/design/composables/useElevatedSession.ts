// SPDX-License-Identifier: BUSL-1.1
// What the quiet "writes unlocked" indicators show and do, in the sidebar
// and in the Old School status bar.

import { computed, ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

export function useElevatedSession() {
  const auth = useAuthStore();
  const toast = useToast();
  const ending = ref(false);

  // A clock time rather than a ticking countdown: activity keeps moving the
  // idle end, and the next write simply prompts step-up again. The server
  // caps the idle end at the absolute end; once they meet, activity no
  // longer moves it, so "if idle" would mislead.
  const until = computed(() => {
    const iso = auth.elevatedIdleEndsAt;
    if (!iso) return null;
    const idleEnd = new Date(iso);
    const absolute = auth.actor?.elevated.absoluteExpiresAt;
    const time = idleEnd.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const capped = absolute != null && new Date(absolute).getTime() <= idleEnd.getTime();
    return capped ? `until ${time}` : `until ${time} if idle`;
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

  return { active: computed(() => auth.elevated), until, summary, ending, end };
}
