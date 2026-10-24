// SPDX-License-Identifier: BUSL-1.1
import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type { LicenseSku } from '@openaduc/shared';
import { api } from '../api/index.js';
import { useAuthStore } from './auth.js';

// Read again after this long; the server's cache refreshes hourly.
const STALE_MS = 5 * 60_000;

/**
 * The groups that grant a Microsoft license, from the server's cache, so
 * every group picker can badge them without a request per group. Loaded
 * once and shared; a group's page updates its own entry.
 */
export const useLicensedGroupsStore = defineStore('licensedGroups', () => {
  /** The directory's Entra integration shows licenses. */
  const enabled = ref(false);
  const byId = shallowRef(new Map<string, LicenseSku[]>());
  let loadedFor: number | null = null;
  let loadedAt = 0;
  let loading: Promise<void> | null = null;

  /** Load unless a recent read for this directory is at hand. */
  function ensureLoaded(): Promise<void> {
    const directoryId = useAuthStore().actor?.directoryId ?? null;
    if (directoryId === null) return Promise.resolve();
    if (directoryId === loadedFor && Date.now() - loadedAt < STALE_MS) return Promise.resolve();
    loading ??= Promise.resolve()
      .then(() => api.groups.licensed())
      .then((res) => {
        enabled.value = res.enabled;
        byId.value = new Map(res.groups.map((g) => [g.id, g.licenses]));
      })
      // A badge is a hint: without the list, pickers show none until the next read.
      .catch(() => undefined)
      .finally(() => {
        loadedFor = directoryId;
        loadedAt = Date.now();
        loading = null;
      });
    return loading;
  }

  const licensesOf = (groupId: string): LicenseSku[] => byId.value.get(groupId) ?? [];

  /** What a group's page just read live. */
  function setGroup(groupId: string, licenses: LicenseSku[]): void {
    const next = new Map(byId.value);
    if (licenses.length) next.set(groupId, licenses);
    else next.delete(groupId);
    byId.value = next;
  }

  return { enabled, ensureLoaded, licensesOf, setGroup };
});
