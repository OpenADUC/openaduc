// SPDX-License-Identifier: BUSL-1.1
import {
  useAccountExpiry,
  type ExpiryRun,
  type ExpirySubject,
} from '../../design/composables/useAccountExpiry.js';
import { expiryFailedSummary, expirySetSummary } from '../../design/feedback/userToasts.js';
import { useUndoableDialog } from './useUndoableDialog';

/** The Account expiry dialog on a user's page (see useUndoableDialog). */
export function useExpiryDialog(options: {
  id: () => string;
  /** Refresh the page once the expiry has changed. */
  onSet: () => void | Promise<void>;
}) {
  const dialog = useUndoableDialog<ExpiryRun, ReturnType<typeof useAccountExpiry>>({
    id: options.id,
    workflow: (landed) =>
      useAccountExpiry({
        onSet: (account, expiresAt, offer) =>
          landed(expirySetSummary(account.name, expiresAt), offer),
      }),
    onLanded: options.onSet,
    failedSummary: (op) => expiryFailedSummary(op.account.name),
  });
  const expiry = dialog.workflow;

  function show(account: ExpirySubject): void {
    expiry.load(account);
    dialog.open.value = true;
  }

  return {
    expiry,
    open: dialog.open,
    show,
    close: dialog.close,
    dialogFailure: dialog.dialogFailure,
    pageFailure: dialog.pageFailure,
    submitting: expiry.submitting,
  };
}
