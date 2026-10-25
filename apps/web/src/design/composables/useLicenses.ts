// SPDX-License-Identifier: BUSL-1.1
import { ref, shallowRef } from 'vue';
import type { GroupLicenses, UserLicenses } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { latestRequest } from '../lib/latestRequest.js';
import { useLicensedGroupsStore } from '../../stores/licensedGroups.js';

/** A live read of an object's licenses: the latest load's answer, or why it failed. */
function useLicenseRead<T>(read: (id: string) => Promise<T>) {
  const licenses = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loads = latestRequest();

  async function load(id: string): Promise<void> {
    const isCurrent = loads.begin();
    licenses.value = null;
    error.value = null;
    loading.value = true;
    try {
      const found = await read(id);
      if (isCurrent()) licenses.value = found;
    } catch (err) {
      if (isCurrent()) error.value = err instanceof ApiError ? err.message : String(err);
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  return { licenses, loading, error, load };
}

/** A user's Microsoft licenses, each with the group it comes from or that it's direct. */
export function useUserLicenses() {
  return useLicenseRead<UserLicenses>((id) => api.users.licenses(id));
}

/** The licenses a group grants. Group pickers' badges follow what this reads. */
export function useGroupLicenses() {
  const licensed = useLicensedGroupsStore();
  return useLicenseRead<GroupLicenses>(async (id) => {
    const found = await api.groups.licenses(id);
    licensed.setGroup(id, found.status === 'synced' ? found.licenses : []);
    return found;
  });
}
