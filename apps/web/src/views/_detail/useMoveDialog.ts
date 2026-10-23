// SPDX-License-Identifier: BUSL-1.1
import type { AccountKind } from '../../design/composables/useAccountActions.js';
import { useAccountMove, type MoveRun } from '../../design/composables/useAccountMove.js';
import { useUndoableDialog } from './useUndoableDialog';

/** The Move to OU dialog on a user's or computer's page (see useUndoableDialog). */
export function useMoveDialog(options: {
  kind: AccountKind;
  id: () => string;
  /** Refresh the page once the account has moved. */
  onMoved: () => void | Promise<void>;
}) {
  const dialog = useUndoableDialog<MoveRun, ReturnType<typeof useAccountMove>>({
    id: options.id,
    workflow: (landed) =>
      useAccountMove({
        kind: options.kind,
        onMoved: (account, to, offer) => landed(`Moved ${account.name} to ${ouName(to)}`, offer),
      }),
    onLanded: options.onMoved,
    failedSummary: (op) => `Couldn’t move ${op.account.name} to ${ouName(op.destinationDn)}`,
  });
  const move = dialog.workflow;
  // Annotated, so TypeScript can type the callbacks above that use it.
  function ouName(dn: string): string {
    return move.ouName(dn);
  }

  function show(): void {
    dialog.open.value = true;
    void move.load(options.id());
  }

  return {
    move,
    open: dialog.open,
    show,
    close: dialog.close,
    dialogFailure: dialog.dialogFailure,
    pageFailure: dialog.pageFailure,
    submitting: move.submitting,
  };
}
