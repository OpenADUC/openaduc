// SPDX-License-Identifier: BUSL-1.1
import { PREVIEW_LIST_LIMIT, type PreviewUser } from '@openaduc/shared';

/**
 * A preview's list of users: counted in full, listed from `offset` up to
 * `limit` of them (they're added sorted by name).
 */
export function previewList<T = PreviewUser>(offset = 0, limit = PREVIEW_LIST_LIMIT) {
  const list = { count: 0, users: [] as T[] };
  return {
    list,
    add(user: T): void {
      if (list.count >= offset && list.users.length < limit) list.users.push(user);
      list.count++;
    },
  };
}
