// SPDX-License-Identifier: BUSL-1.1
import type { GroupSummary } from '@openaduc/shared';
import type { ToastMessageOptions } from 'primevue/toast';

/** The success toast for a new group, wherever it was created from. */
export function groupCreatedToast(
  group: Pick<GroupSummary, 'name' | 'samAccountName'>,
): ToastMessageOptions {
  return {
    severity: 'success',
    summary: 'Group created',
    detail: `${group.name ?? group.samAccountName} was created.`,
    life: 4000,
  };
}
