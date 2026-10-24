// SPDX-License-Identifier: BUSL-1.1
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type { LicenseSku } from '@openaduc/shared';
import { api } from '../api/index.js';
import { fmtRelative } from '../design/lib/format.js';
import { useAuthStore } from './auth.js';

// Read again after this long; the server's cache refreshes hourly.
const STALE_MS = 5 * 60_000;
// Three missed hourly refreshes: the badges may be out of date.
const BADGES_OLD_MS = 3 * 60 * 60_000;

/**
 * The groups that grant a Microsoft license, from the server's cache, so
 * every group picker can badge them without a request per group. Loaded
 * once per directory and shared; a group's page updates its own entry.
 */
export const useLicensedGroupsStore = defineStore('licensedGroups', () => {
  /** The directory's Entra integration shows licenses; null until known. */
  const enabled = ref<boolean | null>(null);
  const byId = shallowRef(new Map<string, LicenseSku[]>());
  const refreshedAt = ref<string | null>(null);
  const refreshFailed = ref(false);
  /** The list itself couldn't be read, after it last showed licenses on. */
  const loadFailed = ref(false);
  let loadedFor: number | null = null;
  let loadedAt = 0;
  let loading: { directoryId: number; done: Promise<void> } | null = null;

  function forget(): void {
    enabled.value = null;
    byId.value = new Map();
    refreshedAt.value = null;
    refreshFailed.value = false;
  }

  /** Load unless a recent read for the operator's directory is at hand. */
  function ensureLoaded(): Promise<void> {
    const directoryId = useAuthStore().actor?.directoryId ?? null;
    if (directoryId !== loadedFor) {
      forget();
      loadFailed.value = false;
      loadedFor = directoryId;
      loadedAt = 0;
    }
    if (directoryId === null) return Promise.resolve();
    if (Date.now() - loadedAt < STALE_MS) return Promise.resolve();
    if (loading?.directoryId === directoryId) return loading.done;

    const isCurrent = () => loadedFor === directoryId;
    const done: Promise<void> = Promise.resolve()
      .then(() => api.groups.licensed())
      .then((res) => {
        if (!isCurrent()) return;
        enabled.value = res.enabled;
        byId.value = new Map(res.groups.map((g) => [g.id, g.licenses]));
        refreshedAt.value = res.refreshedAt;
        refreshFailed.value = res.refreshFailed;
        loadFailed.value = false;
      })
      .catch(() => {
        if (!isCurrent()) return;
        // Unknown, rather than badges that may no longer be true.
        loadFailed.value ||= enabled.value === true;
        forget();
      })
      .finally(() => {
        if (isCurrent()) loadedAt = Date.now();
        if (loading?.done === done) loading = null;
      });
    loading = { directoryId, done };
    return done;
  }

  const licensesOf = (groupId: string): LicenseSku[] => byId.value.get(groupId) ?? [];

  /** What a group's page just read live. */
  function setGroup(groupId: string, licenses: LicenseSku[]): void {
    const next = new Map(byId.value);
    if (licenses.length) next.set(groupId, licenses);
    else next.delete(groupId);
    byId.value = next;
  }

  /** Why the badges may be missing or out of date; null when they're current. */
  const badgeNote = computed((): string | null => {
    if (loadFailed.value)
      return 'License badges couldn’t be loaded, so licensed groups aren’t marked.';
    if (enabled.value !== true) return null;
    const when = refreshedAt.value ? `Last updated ${fmtRelative(refreshedAt.value)}.` : '';
    if (refreshFailed.value) {
      return `License badges couldn’t be refreshed from Microsoft Entra. ${when || 'They haven’t been read yet.'}`.trim();
    }
    if (!refreshedAt.value)
      return 'License badges appear once OpenADUC first reads them from Microsoft Entra.';
    if (Date.now() - new Date(refreshedAt.value).getTime() > BADGES_OLD_MS) {
      return `License badges may be out of date. ${when}`;
    }
    return null;
  });

  return { ensureLoaded, licensesOf, setGroup, badgeNote };
});
