// SPDX-License-Identifier: BUSL-1.1
import type { GroupCreateResponse } from '@openaduc/shared';
import type { ToastMessageOptions } from 'primevue/toast';
import { rdns } from '../lib/dn.js';

/** The success toast for a new group, wherever it was created from. */
export function groupCreatedToast(created: GroupCreateResponse): ToastMessageOptions {
  const leaf = rdns(created.distinguishedName)[0] ?? '';
  const name = created.group?.name ?? leaf.slice(leaf.indexOf('=') + 1);
  return {
    severity: 'success',
    summary: 'Group created',
    detail: `${name} was created.`,
    life: 4000,
  };
}
