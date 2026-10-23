// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, type Ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { undoable } from '../../design/feedback/undoToast.js';
import { placeFailure } from '../../design/lib/failurePlacement.js';
import type { UndoOffer, WriteFailure } from '../../design/lib/undoableWrite.js';
import type { ObjectActionFailure } from './objectPage';

/** What the dialog needs of the workflow it renders. */
interface DialogWorkflow<Op> {
  failure: Readonly<Ref<WriteFailure<Op> | null>>;
  retry: () => void;
  dismiss: () => void;
}

/**
 * A dialog on an object's page that makes one undoable write. The write's
 * success toast offers Undo, the dialog closes and the page refreshes. A
 * failed write shows in the dialog that made it while that's open, else
 * (an Undo's failure) as `pageFailure` for the Actions menu; closing the
 * dialog gives up on a write that failed in it.
 */
export function useUndoableDialog<
  Op extends { account: { id: string } },
  W extends DialogWorkflow<Op>,
>(options: {
  id: () => string;
  /**
   * Build the workflow. Its success callback hands `landed` the toast's
   * summary and the offer of Undo.
   */
  workflow: (landed: (summary: string, offer: UndoOffer) => Promise<void>) => W;
  /** Refresh the page once the write has landed. */
  onLanded: () => void | Promise<void>;
  /** What a failed write was trying to do, as "Couldn't …". */
  failedSummary: (op: Op) => string;
}) {
  const toast = useToast();
  const open = ref(false);
  const workflow = options.workflow(async (summary, offer) => {
    toast.add(undoable({ severity: 'success', summary, life: 4000 }, offer));
    open.value = false;
    await options.onLanded();
  });

  const { inDialog, onPage } = placeFailure(workflow.failure, {
    belongsHere: (f) => f.op.account.id === options.id(),
    dialog: { open: () => open.value, made: (f) => !f.undo },
  });

  function close(): void {
    open.value = false;
    if (inDialog.value) workflow.dismiss();
  }

  const pageFailure = computed<ObjectActionFailure | null>(() => {
    const f = onPage.value;
    if (!f) return null;
    return {
      summary: options.failedSummary(f.op),
      message: f.message,
      retry: workflow.retry,
      dismiss: workflow.dismiss,
    };
  });

  return { workflow, open, close, dialogFailure: inDialog, pageFailure };
}
