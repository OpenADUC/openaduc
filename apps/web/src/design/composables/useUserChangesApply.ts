// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import type { UserDetail } from '@openaduc/shared';
import { useAccountActions } from './useAccountActions.js';
import { useUserAttributeEdit } from './useUserAttributeEdit.js';

/**
 * Attribute edits and an unlock applied together, as one Apply: the
 * attributes are saved first, then the account is unlocked.
 */
export function useUserChangesApply(options: {
  onApplied: () => void | Promise<void>;
  onFailed: (summary: string, detail: string) => void | Promise<void>;
  /** Re-read the account, also after an Apply that only got partway. */
  refresh: () => void | Promise<void>;
}) {
  const user = ref<UserDetail | null>(null);
  const unlock = ref(false);
  // Whether the Apply under way has saved its attributes, which decides
  // what a failed unlock means.
  const attributesSaved = ref(false);

  const edit = useUserAttributeEdit({
    onFailed: (message) => options.onFailed('Apply failed', message),
  });
  const account = useAccountActions<UserDetail>({
    onDone: () => undefined,
    onFailed: async (_action, _u, message) => {
      if (!attributesSaved.value) return options.onFailed('Unlock failed', message);
      await options.onFailed('Changes applied, but the account was not unlocked.', message);
      await options.refresh();
    },
  });

  const unlocking = computed(() => unlock.value && user.value?.locked === true);
  const dirty = computed(() => edit.dirty.value || unlocking.value);
  const applying = computed(
    () => edit.saving.value || (!!user.value && account.runningOn(user.value.id) !== null),
  );

  function reset(u: UserDetail | null): void {
    user.value = u;
    unlock.value = false;
    edit.reset(u);
  }

  /** `after` runs once everything is applied, including after a step-up. */
  function apply(after?: () => void | Promise<void>): void {
    const u = user.value;
    if (!u || !dirty.value || !edit.valid.value || applying.value) return;
    attributesSaved.value = false;
    const andUnlock = unlocking.value;
    const applied = async (): Promise<void> => {
      await options.onApplied();
      await options.refresh();
      await after?.();
    };
    const unlockThenApplied = (): void | Promise<void> =>
      andUnlock ? account.run('unlock', u, applied) : applied();
    if (!edit.dirty.value) return void unlockThenApplied();
    edit.save(() => {
      attributesSaved.value = true;
      return unlockThenApplied();
    });
  }

  return {
    draft: edit.draft,
    problems: edit.problems,
    valid: edit.valid,
    unlock,
    dirty,
    applying,
    reset,
    apply,
  };
}
