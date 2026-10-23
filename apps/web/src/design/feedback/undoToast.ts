// SPDX-License-Identifier: BUSL-1.1
import type { ToastMessageOptions } from 'primevue/toast';

/** Long enough to notice the toast and reach its Undo button. */
export const UNDO_TOAST_LIFE_MS = 8000;

export interface UndoableToastMessage extends ToastMessageOptions {
  undo?: () => void;
}

/**
 * A success toast that offers Undo, when the change can be undone. Render
 * it with `AppToast`, which shows the button.
 */
export function undoable(
  message: ToastMessageOptions,
  undo: (() => void) | null,
): UndoableToastMessage {
  if (!undo) return message;
  return { ...message, life: Math.max(message.life ?? 0, UNDO_TOAST_LIFE_MS), undo };
}
