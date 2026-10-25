// SPDX-License-Identifier: BUSL-1.1
import type { ToastMessageOptions } from 'primevue/toast';
import type { UndoOffer } from '../lib/undoableWrite.js';

/** Long enough to notice the toast and reach its Undo button. */
export const UNDO_TOAST_LIFE_MS = 8000;

export interface UndoableToastMessage extends ToastMessageOptions {
  undo?: () => void;
  /** How long an Undo toast shows, not counting while it's hovered or focused. */
  undoLife?: number;
}

/**
 * A success toast that offers Undo, or says why the change can't be undone.
 * Render it with `AppToast`, which shows the button and times the toast
 * itself so it doesn't vanish while the operator is on it.
 */
export function undoable(message: ToastMessageOptions, offer: UndoOffer): UndoableToastMessage {
  if (!offer) return message;
  if ('cannotUndo' in offer) {
    return { ...message, detail: [message.detail, offer.cannotUndo].filter(Boolean).join(' ') };
  }
  const { life, ...rest } = message;
  return { ...rest, undoLife: Math.max(life ?? 0, UNDO_TOAST_LIFE_MS), undo: offer.undo };
}
