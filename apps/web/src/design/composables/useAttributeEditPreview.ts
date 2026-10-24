// SPDX-License-Identifier: BUSL-1.1
// The preview a bulk attribute edit shows before it runs: user by user
// what it would change, a page at a time, and the request that starts the
// job on exactly what was previewed. Shared by the bulk edit and by
// reassigning a manager's direct reports.

import { computed, ref, shallowRef } from 'vue';
import type {
  BulkAttributeChanges,
  BulkUserAttributesPreview,
  BulkUserAttributesRequest,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';

const message = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));

export function useAttributeEditPreview() {
  const preview = shallowRef<BulkUserAttributesPreview | null>(null);
  // What the preview was asked for, which the job then runs on.
  let previewed: { ids: string[]; changes: BulkAttributeChanges } | null = null;
  const previewing = ref(false);
  const previewError = ref<string | null>(null);
  const loadingMore = ref(false);
  const previews = latestRequest();

  // Users whose value the cache hasn't read may change too.
  const mayChange = computed(() =>
    preview.value ? preview.value.changed.count + preview.value.unread.count : 0,
  );
  const canConfirm = computed(() => mayChange.value > 0);
  const hasMore = computed(
    () => !!preview.value && preview.value.changed.users.length < preview.value.changed.count,
  );

  function forget(): void {
    previews.begin();
    preview.value = null;
    previewed = null;
    previewing.value = false;
    loadingMore.value = false;
    previewError.value = null;
  }

  async function review(ids: string[], changes: BulkAttributeChanges): Promise<void> {
    const isCurrent = previews.begin();
    previewing.value = true;
    previewError.value = null;
    const asked = { ids, changes: { ...changes } };
    try {
      const result = await api.users.previewAttributeEdit(asked);
      if (isCurrent()) {
        preview.value = result;
        previewed = asked;
      }
    } catch (err) {
      if (isCurrent()) previewError.value = message(err);
    } finally {
      if (isCurrent()) previewing.value = false;
    }
  }

  /** The next page of the users it changes, added to the preview's list. */
  async function showMore(): Promise<void> {
    const shownPreview = preview.value;
    if (!shownPreview || !previewed || !hasMore.value || loadingMore.value) return;
    const isCurrent = previews.begin();
    loadingMore.value = true;
    try {
      const next = await api.users.previewAttributeEdit({
        ...previewed,
        offset: shownPreview.changed.users.length,
      });
      if (!isCurrent()) return;
      if (next.previewToken !== shownPreview.previewToken) {
        forget();
        previewError.value = 'The users changed since the preview. Preview it again.';
        return;
      }
      preview.value = {
        ...next,
        changed: { ...next.changed, users: [...shownPreview.changed.users, ...next.changed.users] },
      };
    } catch (err) {
      if (isCurrent()) previewError.value = message(err);
    } finally {
      if (isCurrent()) loadingMore.value = false;
    }
  }

  /**
   * The job's request, on what was previewed, if `ids` are still the users
   * previewed; otherwise the preview is forgotten and says to preview again.
   */
  function request(ids: string[]): BulkUserAttributesRequest | null {
    const shownPreview = preview.value;
    if (!shownPreview || !previewed || !canConfirm.value) return null;
    const now = new Set(ids);
    if (now.size !== previewed.ids.length || previewed.ids.some((id) => !now.has(id))) {
      forget();
      previewError.value = 'The selection changed since the preview. Preview it again.';
      return null;
    }
    return {
      ids: previewed.ids,
      changes: previewed.changes,
      previewToken: shownPreview.previewToken,
    };
  }

  return {
    preview,
    previewing,
    previewError,
    mayChange,
    canConfirm,
    hasMore,
    loadingMore,
    forget,
    review,
    showMore,
    request,
  };
}
